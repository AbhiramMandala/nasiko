use std::time::Instant;

use nasiko_observability::ObservabilityProvider;
use sqlx::PgPool;
use uuid::Uuid;

use super::llm::{ChatMessage, LlmClient};
use super::types::{ExecutionResult, MafDefinition, MafStep, StepResult};

pub async fn run_maf(
    client: &reqwest::Client,
    db: &PgPool,
    observability: &dyn ObservabilityProvider,
    execution_id: Uuid,
    user_id: Uuid,
    maf_def: &MafDefinition,
    llm: &LlmClient,
) -> Result<ExecutionResult, String> {
    // Seed one "pending" entry per step and persist immediately, so the full
    // step list is visible in the DB before the (possibly slow) planning LLM
    // call even starts.
    let mut step_results: Vec<StepResult> = maf_def.steps.iter().map(pending_result).collect();
    let mut total_cost = 0f64;
    persist_progress(db, execution_id, &step_results, 0, total_cost).await;

    // ── LLM call 1: plan all steps at runtime ────────────────────────────────
    // Generates prompt templates (with <placeholders>), to_extract goals, and
    // the output_generation guideline from the task descriptions.
    // Planning happens on every execution (Python MAF parity).
    let (step_plans, output_generation, plan_tokens) = plan_execution(&maf_def.steps, llm).await?;
    let mut total_tokens = plan_tokens;

    // Fill in the prompt template / extraction goal now that planning is
    // done — steps stay "pending" until their turn in the loop below.
    for (result, plan) in step_results.iter_mut().zip(step_plans.iter()) {
        result.prompt_template = plan.prompt.clone();
        result.to_extract = plan.to_extract.clone();
    }
    persist_progress(db, execution_id, &step_results, total_tokens, total_cost).await;

    for (i, (step, plan)) in maf_def.steps.iter().zip(step_plans.iter()).enumerate() {
        let context = build_context(&step_results[..i]);

        step_results[i].status = "running".to_string();
        persist_progress(db, execution_id, &step_results, total_tokens, total_cost).await;

        // ── LLM call 2: fill <placeholders> with context from previous steps ─
        let (actual_prompt, prompt_tokens) =
            match generate_step_prompt(&plan.prompt, &step.task_description, &context, llm).await {
                Ok(v) => v,
                Err(e) => {
                    let err = format!("step {}: prompt generation failed: {e}", step.step_index);
                    step_results[i].status = "failed".to_string();
                    step_results[i].error = Some(err.clone());
                    persist_progress(db, execution_id, &step_results, total_tokens, total_cost)
                        .await;
                    return Err(err);
                }
            };

        // ── Agent call ────────────────────────────────────────────────────────
        let start = Instant::now();
        let (traceparent, trace_id) = build_traceparent(execution_id, step.step_index);

        // Register this step as a flow so the LLM gateway sees it as IN-FLOW (not
        // inert) and its tier classifier can fire. The invariant the gateway relies
        // on (see `derive_boundary_signals`): the trace_id we forward in
        // `traceparent` IS the `flow_id` in this row — mirroring the orchestrator /
        // agent-proxy ingress. `context_id = execution_id` is stable across every
        // step, so the gateway keys its decision cache on the whole MAF run: the
        // first step writes the tier decision, later steps reuse it. Best-effort —
        // a failed insert only means this step falls back to the default model.
        let flow_metadata = serde_json::json!({
            "context_id": execution_id.to_string(),
            "mode": "free_flowing",
        });
        let _ = sqlx::query(
            r#"INSERT INTO flows (flow_id, user_id, root_agent_name, title, status, metadata)
               VALUES ($1, $2, $3, $4, 'running', $5)
               ON CONFLICT (flow_id) DO NOTHING"#,
        )
        .bind(&trace_id)
        .bind(user_id)
        .bind(&step.agent_name)
        .bind(&step.task_description)
        .bind(&flow_metadata)
        .execute(db)
        .await;
        // Participant record — the MCP gateway / LLM router only authorize this
        // step's agent for calls carrying this trace id if it is recorded here
        // (docs/MCP_GATEWAY_AGENT_AUTH.md §2.4). Same synchronous pre-call write
        // as the flows row; a failed insert denies (never escalates) downstream.
        if let Err(e) = sqlx::query(
            "INSERT INTO flow_participants (flow_id, agent_id) VALUES ($1, $2)
             ON CONFLICT (flow_id, agent_id) DO NOTHING",
        )
        .bind(&trace_id)
        .bind(step.agent_id)
        .execute(db)
        .await
        {
            tracing::warn!(
                error = %e, flow_id = %trace_id, agent_id = %step.agent_id,
                "flow participant record failed — the step agent's MCP/LLM calls will be denied"
            );
        }

        let raw_response = match call_agent(
            client,
            &step.agent_endpoint,
            &execution_id.to_string(),
            &user_id.to_string(),
            &actual_prompt,
            &traceparent,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let err = format!(
                    "step {} (agent '{}') failed: {e}",
                    step.step_index, step.agent_name
                );
                step_results[i].status = "failed".to_string();
                step_results[i].prompt = actual_prompt;
                step_results[i].error = Some(err.clone());
                persist_progress(db, execution_id, &step_results, total_tokens, total_cost).await;
                return Err(err);
            }
        };
        let latency_ms = start.elapsed().as_millis() as i64;

        // ── LLM call 3: extract relevant info from agent response ─────────────
        let (extracted, extract_tokens) = match extract_info(
            &plan.prompt,
            &actual_prompt,
            &raw_response,
            &plan.to_extract,
            &context,
            llm,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let err = format!("step {}: extraction failed: {e}", step.step_index);
                step_results[i].status = "failed".to_string();
                step_results[i].prompt = actual_prompt;
                step_results[i].latency_ms = latency_ms;
                step_results[i].error = Some(err.clone());
                persist_progress(db, execution_id, &step_results, total_tokens, total_cost).await;
                return Err(err);
            }
        };

        let llm_tokens = prompt_tokens + extract_tokens;

        // Wait for the agent's own token usage to land in Tempo (it batches
        // span export, so it's usually not there the instant the call
        // returns) so the persisted step total already reflects LLM + agent
        // cost together, not just MAF's own reasoning cost.
        let agent_usage = wait_for_agent_usage(observability, &trace_id).await;
        let step_tokens = llm_tokens + agent_usage.input as i64 + agent_usage.output as i64;
        total_tokens += step_tokens;

        // Cost is agent-call spend only (not MAF's own planning/reasoning LLM
        // calls) — keeps Agent-view and Workflow-view FinOps rows apples-to-
        // apples, since agent-view cost is also agent-spend-only.
        let step_cost = observability
            .cost(
                agent_usage.model.as_deref(),
                agent_usage.input,
                agent_usage.output,
            )
            .await
            .total_usd;
        total_cost += step_cost;

        let new_context = if context.is_empty() {
            format!(
                "Step {} ({}): {}",
                step.step_index, step.agent_name, extracted
            )
        } else {
            format!(
                "{}\nStep {} ({}): {}",
                context, step.step_index, step.agent_name, extracted
            )
        };

        step_results[i].status = "success".to_string();
        step_results[i].prompt = actual_prompt;
        step_results[i].extracted_info = Some(extracted);
        step_results[i].tokens_used = step_tokens;
        step_results[i].input_tokens = agent_usage.input as i64;
        step_results[i].output_tokens = agent_usage.output as i64;
        step_results[i].cache_read_tokens = agent_usage.cache_read as i64;
        step_results[i].cache_creation_tokens = agent_usage.cache_creation as i64;
        step_results[i].model_used = agent_usage.model;
        step_results[i].cost_usd = step_cost;
        step_results[i].latency_ms = latency_ms;
        step_results[i].context = Some(new_context);
        persist_progress(db, execution_id, &step_results, total_tokens, total_cost).await;
    }

    // ── LLM call 4: synthesise final output ───────────────────────────────────
    // Use the guidelines generated by the planner at runtime.
    let guidelines = &output_generation;

    let (output, output_tokens) = generate_final_output(&step_results, guidelines, llm)
        .await
        .map_err(|e| format!("final output generation failed: {e}"))?;
    total_tokens += output_tokens;

    Ok(ExecutionResult {
        output,
        step_results,
        tokens_used: total_tokens,
        cost_usd: total_cost,
    })
}

/// Builds a placeholder "pending" entry for a step before planning/execution
/// has produced any of its actual content.
fn pending_result(step: &MafStep) -> StepResult {
    StepResult {
        step_id: step.step_id,
        step_index: step.step_index,
        agent_id: step.agent_id,
        agent_name: step.agent_name.clone(),
        status: "pending".to_string(),
        error: None,
        prompt_template: String::new(),
        to_extract: String::new(),
        prompt: String::new(),
        extracted_info: None,
        tokens_used: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        model_used: None,
        cost_usd: 0.0,
        latency_ms: 0,
        context: None,
        obs_logs: serde_json::Value::Null,
    }
}

/// Writes the current step progress snapshot to `maf_executions.step_results`.
/// Best-effort: a transient write failure here shouldn't abort the run — the
/// next transition will just overwrite with fresher data, and the final
/// write in worker.rs remains the source of truth once the run completes.
async fn persist_progress(
    db: &PgPool,
    execution_id: Uuid,
    step_results: &[StepResult],
    tokens_used: i64,
    cost_usd: f64,
) {
    let step_json = serde_json::to_value(step_results).unwrap_or_default();
    let _ = sqlx::query(
        "UPDATE maf_executions SET step_results = $1::jsonb, tokens_used = $2, cost_usd = $3 WHERE id = $4",
    )
    .bind(step_json.to_string())
    .bind(tokens_used)
    .bind(cost_usd)
    .bind(execution_id)
    .execute(db)
    .await;
}

// ─── Step plan produced by plan_execution ────────────────────────────────────

struct StepPlan {
    prompt: String,
    to_extract: String,
}

// ─── LLM call 1: runtime planner ─────────────────────────────────────────────

async fn plan_execution(
    steps: &[MafStep],
    llm: &LlmClient,
) -> Result<(Vec<StepPlan>, String, i64), String> {
    let system = "You are a MAF (Multi-Agent Flow) step planner.\n\
                  Given a list of steps (each with a task description and the agent that will \
                  handle it), generate:\n\
                  1. For each step — a prompt template and a to_extract goal.\n\
                     - IMPORTANT: For the FIRST step (step 0), NEVER use placeholders. Use the exact \
                     values (amounts, currencies, names, etc.) from the task description verbatim.\n\
                     - For subsequent steps, use <variable_name> syntax (e.g. <jpy_amount>) ONLY to \
                     reference data that was extracted from a previous step — never for values that are \
                     already stated in the task description.\n\
                     - Include the placeholder name in to_extract only when a later step needs the value.\n\
                  2. An output_generation string describing how to present the final answer to the user.\n\n\
                  Return ONLY valid JSON:\n\
                  {\n\
                    \"output_generation\": \"...\",\n\
                    \"steps\": [{\"prompt\": \"...\", \"to_extract\": \"...\"}, ...]\n\
                  }\n\
                  The steps array must have exactly one entry per input step, in the same order.";

    let one_shot_human = "Steps:\n\
                          Step 0 (Fantasy Book Recommender): Recommend at least three fantasy books\n\
                          Step 1 (Online Book Shopping Agent): Find the best deals for the recommended books";

    let one_shot_assistant = r#"{"output_generation": "Present the top three fantasy book recommendations along with the best online deal for each, including store name and price.", "steps": [{"prompt": "Recommend at least three fantasy books.", "to_extract": "The top three fantasy book recommendations including title and author (<top_three_recommendations>)"}, {"prompt": "Here are the three books I want to buy: <top_three_recommendations>. Find out the best deals for these books online.", "to_extract": "Best online deals for each book including store name, price, and a direct purchase link if available"}]}"#;

    let step_list = steps
        .iter()
        .map(|s| {
            format!(
                "Step {} ({}): {}",
                s.step_index, s.agent_name, s.task_description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let user = format!("Steps:\n{step_list}");

    // Schema matches Python's MAFTemplate Pydantic model — strict enforcement via
    // OpenAI structured outputs, equivalent to `with_structured_output(MAFTemplate)`.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "output_generation": {"type": "string"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string"},
                        "to_extract": {"type": "string"}
                    },
                    "required": ["prompt", "to_extract"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["output_generation", "steps"],
        "additionalProperties": false
    });

    let (json, tokens) = llm
        .chat_json_schema(
            vec![
                ChatMessage::system(system),
                ChatMessage::user(one_shot_human),
                ChatMessage::assistant(one_shot_assistant),
                ChatMessage::user(user),
            ],
            "execution_plan",
            schema,
        )
        .await?;

    let output_generation = json["output_generation"]
        .as_str()
        .unwrap_or("Summarise all extracted information into a clear, well-structured response.")
        .to_string();

    let plans_json = json["steps"]
        .as_array()
        .ok_or_else(|| "planner returned no 'steps' array".to_string())?;

    if plans_json.len() != steps.len() {
        return Err(format!(
            "planner returned {} step plans but MAF has {} steps",
            plans_json.len(),
            steps.len()
        ));
    }

    let plans = plans_json
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let prompt = p["prompt"]
                .as_str()
                .ok_or_else(|| format!("step {i}: planner returned no 'prompt'"))?
                .to_string();
            let to_extract = p["to_extract"]
                .as_str()
                .ok_or_else(|| format!("step {i}: planner returned no 'to_extract'"))?
                .to_string();
            Ok(StepPlan { prompt, to_extract })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok((plans, output_generation, tokens))
}

// ─── LLM call 2: prompt generator ────────────────────────────────────────────

async fn generate_step_prompt(
    template: &str,
    task_description: &str,
    context: &str,
    llm: &LlmClient,
) -> Result<(String, i64), String> {
    // No placeholders — send the template verbatim, no LLM call needed.
    if !template.contains('<') {
        return Ok((template.to_string(), 0));
    }

    // When there are no prior step results, use the task description so the LLM can
    // fill placeholders from values stated explicitly in the task (e.g. "10 rupees").
    let effective_context = if context.is_empty() {
        format!("Task description for this step: {task_description}")
    } else {
        context.to_string()
    };

    // System prompt matches Python's MAFExecutor._create_user_prompt exactly.
    let system = "You are a Multi-Agent Flow (MAF) prompt generator.\n\
                  Your task is to generate a specific, actionable user prompt for an agent \
                  in a linear workflow.\n\n\
                  You will be provided with:\n\
                  1. The **prompt template** for the current step.\n\
                  2. **Context** from previous steps in the flow, including:\n\
                     - The agents used.\n\
                     - The prompt templates used to generate prompts and the actual prompts generated.\n\
                     - What information was intended to be extracted from the agent response \
                  (Goal of Extraction).\n\
                     - The actual information that was extracted from the agent response.\n\n\
                  Your goal is to:\n\
                  - Generate a user prompt for the current step by combining the current prompt \
                  template with the available context.\n\
                  - Replace any placeholders (like <variable_name>) in the prompt template with \
                  actual data from the context.\n\
                  - Ensure the resulting prompt is clear and directly tells the agent what to do, \
                  leveraging the history of the flow.\n\n\
                  Output the result in the specified structured format.";

    // One-shot uses the verbose context format that build_context produces.
    let one_shot_human = "Current Step Prompt Template: Here are the three books I want to buy: \
                          <top_three_recommendations>. Find out the best deals for these books online.\n\n\
                          Context from Previous Steps:\n\
                          --- Step 1 (Fantasy Book Recommender) ---\n\
                          Prompt Template: Recommend at least three fantasy books.\n\
                          User Prompt Sent: Recommend at least three fantasy books.\n\
                          Goal of Extraction: The top three fantasy book recommendations including \
                          title and author (<top_three_recommendations>).\n\
                          Actual Extracted Information: 1. 'The Way of Kings' by Brandon Sanderson, \
                          2. 'The Name of the Wind' by Patrick Rothfuss, \
                          3. 'The Lies of Locke Lamora' by Scott Lynch";

    let one_shot_assistant = r#"{"prompt": "Here are the three books I want to buy: 1. 'The Way of Kings' by Brandon Sanderson, 2. 'The Name of the Wind' by Patrick Rothfuss, 3. 'The Lies of Locke Lamora' by Scott Lynch. Find out the best deals for these books online."}"#;

    let user = if effective_context.is_empty() {
        format!("Current Step Prompt Template: {template}")
    } else {
        format!(
            "Current Step Prompt Template: {template}\n\nContext from Previous Steps:\n{effective_context}"
        )
    };

    // Schema matches Python's GeneratedPrompt Pydantic model.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "prompt": {"type": "string"}
        },
        "required": ["prompt"],
        "additionalProperties": false
    });

    let (json, tokens) = llm
        .chat_json_schema(
            vec![
                ChatMessage::system(system),
                ChatMessage::user(one_shot_human),
                ChatMessage::assistant(one_shot_assistant),
                ChatMessage::user(user),
            ],
            "generated_prompt",
            schema,
        )
        .await?;

    let prompt = json["prompt"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "LLM prompt generation returned no 'prompt' field".to_string())?;

    Ok((prompt, tokens))
}

// ─── LLM call 3: extractor ────────────────────────────────────────────────────

async fn extract_info(
    template: &str,
    actual_prompt: &str,
    response: &str,
    goal: &str,
    context: &str,
    llm: &LlmClient,
) -> Result<(String, i64), String> {
    // System prompt matches Python's MAFExecutor._extract_info exactly.
    let system = "You are a Multi-Agent Flow (MAF) information extractor.\n\
                  Your task is to extract specific information from an agent's response based \
                  on the \"goal of extraction\" for the current step.\n\n\
                  You will be provided with:\n\
                  1. The **prompt template** for the current step.\n\
                  2. The **actual prompt** sent to the agent in the current step.\n\
                  3. The **goal of extraction** for the current step.\n\
                  4. The **agent's response** for the current step.\n\
                  5. **Context** from previous steps in the flow (if any), including:\n\
                     - The agents used.\n\
                     - The prompt templates used to generate prompts.\n\
                     - The actual prompts sent to the agents.\n\
                     - What information was intended to be extracted from the agent response \
                  (Goal of Extraction).\n\
                     - The actual information that was extracted from the agent response.\n\n\
                  Your goal is to:\n\
                  - Extract all information from the agent response that is required by the \
                  goal of extraction.\n\
                  - The goal of extraction may contain placeholders (like <variable_name>), but \
                  it might also mention other specific details to capture. Ensure EVERYTHING \
                  mentioned in the goal is extracted correctly.\n\
                  - The extracted information should be formatted as a clear, standalone piece of \
                  data that can be used as a direct replacement for its context in the workflow.\n\
                  - Use the provided context from previous steps if necessary to understand the \
                  full scope of what needs to be extracted (e.g., if the goal refers to something \
                  previously mentioned).\n\
                  - Ignore any conversational filler or irrelevant information in the agent's \
                  response.\n\n\
                  Output the result in the specified structured format.";

    // One-shot agent response matches Python's _extract_info example exactly.
    let one_shot_human = "Current Step Prompt Template: Recommend at least three fantasy books.\n\
                          Current Step User Prompt Sent: Recommend at least three fantasy books.\n\
                          Current Step Goal of Extraction: The top three fantasy book recommendations \
                          including title and author (<top_three_recommendations>).\n\
                          Current Step Agent Response: Hello! I'd be happy to help. Based on your \
                          interest in fantasy, here are some great reads. First, there's 'The Way of \
                          Kings' by Brandon Sanderson, which is the start of a massive epic. Then, \
                          'The Name of the Wind' by Patrick Rothfuss is a must-read for its beautiful \
                          prose. Finally, I highly recommend 'The Lies of Locke Lamora' by Scott Lynch \
                          for some high-stakes thievery. I've also heard 'Mistborn' is good, but these \
                          three are my top picks for you. Hope this helps!\n\n\
                          Context from Previous Steps:\n\
                          None";

    let one_shot_assistant = r#"{"extracted_info": "1. 'The Way of Kings' by Brandon Sanderson, 2. 'The Name of the Wind' by Patrick Rothfuss, 3. 'The Lies of Locke Lamora' by Scott Lynch"}"#;

    // Match Python: conditionally include context section; write "None" when empty.
    let context_section = if context.is_empty() {
        "Context from Previous Steps:\nNone".to_string()
    } else {
        format!("Context from Previous Steps:\n{context}")
    };

    let user = format!(
        "Current Step Prompt Template: {template}\n\n\
         Current Step User Prompt Sent: {actual_prompt}\n\n\
         Current Step Goal of Extraction: {goal}\n\n\
         Current Step Agent Response: {response}\n\n\
         {context_section}"
    );

    // Schema matches Python's ExtractedInfo Pydantic model — strict enforcement via
    // OpenAI structured outputs, equivalent to `with_structured_output(ExtractedInfo)`.
    // The API guarantees extracted_info is always present and always a string.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "extracted_info": {
                "type": "string",
                "description": "The information extracted from an agent's response."
            }
        },
        "required": ["extracted_info"],
        "additionalProperties": false
    });

    let (json, tokens) = llm
        .chat_json_schema(
            vec![
                ChatMessage::system(system),
                ChatMessage::user(one_shot_human),
                ChatMessage::assistant(one_shot_assistant),
                ChatMessage::user(user),
            ],
            "extraction_result",
            schema,
        )
        .await?;

    let extracted = json["extracted_info"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "LLM extraction returned no 'extracted_info' field".to_string())?;

    Ok((extracted, tokens))
}

// ─── LLM call 4: final output synthesiser ────────────────────────────────────

async fn generate_final_output(
    step_results: &[StepResult],
    guidelines: &str,
    llm: &LlmClient,
) -> Result<(String, i64), String> {
    // System prompt matches Python's MAFExecutor._create_final_output exactly.
    let system = "You are a Multi-Agent Flow (MAF) final output generator.\n\
                  Your task is to consolidate all information extracted from various agents \
                  into a single, cohesive, and helpful response for the user.\n\n\
                  You will be provided with:\n\
                  1. **Guidelines** on how to construct the final output.\n\
                  2. **Context** from previous steps in the flow, including:\n\
                     - The agents used.\n\
                     - The prompt templates used to generate prompts.\n\
                     - The actual prompts sent to the agents.\n\
                     - What information was intended to be extracted from the agent response \
                  (Goal of Extraction).\n\
                     - The actual information that was extracted from the agent response.\n\n\
                  Your goal is to:\n\
                  - Follow the provided guidelines to construct the final answer.\n\
                  - Ensure the response is well-structured, clear, and directly addresses \
                  the user's initial intent.\n\
                  - Leverage all the extracted data to provide a comprehensive result.\n\n\
                  Output the result in the specified structured format.";

    // One-shot context uses the same verbose format that build_context produces.
    let one_shot_human = "Guidelines for Output Generation: Present the top three fantasy book \
                          recommendations along with the best online deals for each, including \
                          store name, price, and a direct purchase link if available.\n\n\
                          Context from All Steps:\n\
                          --- Step 1 (Fantasy Book Recommender) ---\n\
                          Prompt Template: Recommend at least three fantasy books.\n\
                          User Prompt Sent: Recommend at least three fantasy books.\n\
                          Goal of Extraction: The top three fantasy book recommendations including \
                          title and author (<top_three_recommendations>).\n\
                          Actual Extracted Information: 1. 'The Way of Kings' by Brandon Sanderson, \
                          2. 'The Name of the Wind' by Patrick Rothfuss, \
                          3. 'The Lies of Locke Lamora' by Scott Lynch\n\n\
                          --- Step 2 (Online Book Shopping Agent) ---\n\
                          Prompt Template: Here are the three books I want to buy: \
                          <top_three_recommendations>. Find out the best deals for these books online.\n\
                          User Prompt Sent: Here are the three books I want to buy: \
                          1. 'The Way of Kings' by Brandon Sanderson, \
                          2. 'The Name of the Wind' by Patrick Rothfuss, \
                          3. 'The Lies of Locke Lamora' by Scott Lynch. \
                          Find out the best deals for these books online.\n\
                          Goal of Extraction: Best online deals for each book including store name, \
                          price, and a direct purchase link if available.\n\
                          Actual Extracted Information: \
                          1. 'The Way of Kings': Amazon $18.99 — best deal. \
                          2. 'The Name of the Wind': Powell's $15.99 — best deal. \
                          3. 'The Lies of Locke Lamora': Target $14.99 — best deal.";

    let one_shot_assistant = r#"{"final_output": "Here are the top three fantasy book recommendations with their best online deals:\n\n1. **The Way of Kings** by Brandon Sanderson\n   Best deal: Amazon — $18.99\n\n2. **The Name of the Wind** by Patrick Rothfuss\n   Best deal: Powell's Books — $15.99\n\n3. **The Lies of Locke Lamora** by Scott Lynch\n   Best deal: Target — $14.99"}"#;

    let context = build_context(step_results);
    let user = format!(
        "Guidelines for Output Generation: {guidelines}\n\nContext from All Steps:\n{context}"
    );

    // Schema matches Python's FinalOutput Pydantic model.
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "final_output": {
                "type": "string",
                "description": "The final consolidated response for the user."
            }
        },
        "required": ["final_output"],
        "additionalProperties": false
    });

    let (json, tokens) = llm
        .chat_json_schema(
            vec![
                ChatMessage::system(system),
                ChatMessage::user(one_shot_human),
                ChatMessage::assistant(one_shot_assistant),
                ChatMessage::user(user),
            ],
            "final_output",
            schema,
        )
        .await?;

    let output = json["final_output"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "LLM final output returned no 'final_output' field".to_string())?;

    Ok((output, tokens))
}

// ─── A2A agent call ───────────────────────────────────────────────────────────

/// Builds a valid W3C `traceparent` scoped to this one step — not the whole
/// execution — so each step's agent call lands under its own Tempo trace_id.
/// That's what lets per-step (not just per-execution) agent token usage be
/// looked up later without ambiguity when the same agent is used in more
/// than one step. Deterministic (execution_id + step_index) via UUIDv5, so no
/// new dependency and no random-id bookkeeping is needed to reconstruct it
/// later when reading the execution back.
///
/// Returns `(traceparent_header, trace_id)`. The bare `trace_id` (32 hex, no
/// dashes) is the value both the flow-registration insert and the Tempo token
/// lookup key on, so it's returned rather than re-derived at each call site.
fn build_traceparent(execution_id: Uuid, step_index: i32) -> (String, String) {
    let trace_uuid = Uuid::new_v5(&execution_id, step_index.to_string().as_bytes());
    let span_uuid = Uuid::new_v5(&execution_id, format!("{step_index}-span").as_bytes());
    let trace_id = trace_uuid.simple().to_string();
    let span_id = &span_uuid.simple().to_string()[..16];
    // flags=01 (sampled) — otherwise a conforming exporter may decide not to
    // export the span at all, and this whole mechanism would silently no-op.
    let traceparent = format!("00-{trace_id}-{span_id}-01");
    (traceparent, trace_id)
}

/// Polls Tempo for this step's trace (keyed by the `trace_id` that
/// `build_traceparent` forwarded) and returns its total `gen_ai.usage` tokens,
/// or 0 if nothing shows up within the timeout — Tempo/the agent being
/// unreachable never fails the step, it just means this step's persisted total
/// is LLM-only.
struct AgentUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    model: Option<String>,
}

async fn wait_for_agent_usage(
    observability: &dyn ObservabilityProvider,
    trace_id: &str,
) -> AgentUsage {
    // Agents commonly batch-export spans every ~5s, so the trace usually
    // isn't queryable the instant the agent call returns — poll rather than
    // check once.
    for _ in 0..10 {
        if let Ok(trace) = observability.get_trace(trace_id).await {
            let (input, output, model) = trace.token_totals();
            if input + output > 0 {
                let (cache_read, cache_creation) = trace.cache_token_totals();
                return AgentUsage {
                    input,
                    output,
                    cache_read,
                    cache_creation,
                    model,
                };
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    AgentUsage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        model: None,
    }
}

async fn call_agent(
    client: &reqwest::Client,
    endpoint: &str,
    context_id: &str,
    user_id: &str,
    prompt: &str,
    traceparent: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "1",
        // Per the A2A spec (§5.3, §9.1): JSON-RPC method names are PascalCase,
        // matching gRPC conventions exactly — "SendMessage", not "message/send"
        // (that string is only the REST binding's URL path, a different
        // transport). Confirmed both against the spec's own example request
        // and empirically against a real deployed `oss/agents/translator`
        // build. Matches `oss/types::build_send_request`.
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": uuid::Uuid::new_v4().to_string(),
                "contextId": context_id,
                "role": "ROLE_USER",
                "parts": [{"text": prompt}]
            }
        }
    });

    // Some agents expose A2A at /jsonrpc, others at root /. Try /jsonrpc first
    // and fall back to / on 404 so both agent types work without DB changes.
    let base = endpoint.trim_end_matches('/');
    let url_jsonrpc = format!("{base}/jsonrpc");
    let url_root = format!("{base}/");

    // No per-request MCP credential: the agent authenticates to `/api/mcp`
    // with its own deploy-time MCP_GATEWAY_TOKEN, and the user binding rides
    // the forwarded traceparent + the flow_participants record written before
    // this call (docs/MCP_GATEWAY_AGENT_AUTH.md).
    let resp = {
        let r = client
            .post(&url_jsonrpc)
            .header("X-User-Id", user_id)
            .header("A2A-Version", "1.0")
            .header("traceparent", traceparent)
            .json(&body)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            client
                .post(&url_root)
                .header("X-User-Id", user_id)
                .header("A2A-Version", "1.0")
                .header("traceparent", traceparent)
                .json(&body)
                .timeout(std::time::Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| e.to_string())?
        } else {
            r
        }
    };

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(err) = json["error"]["message"].as_str() {
        return Err(format!("A2A error: {err}"));
    }

    Ok(extract_text(&json))
}

fn extract_text(json: &serde_json::Value) -> String {
    // Some agent SDKs nest the task under `result.task`; the ones actually
    // deployed here (confirmed live against `petra-assistant-demo`) return
    // `result` itself AS the task object — `result.artifacts`, no `task`
    // wrapper. Try both nestings for each shape so either SDK version works.
    for root in [&json["result"]["task"], &json["result"]] {
        if let Some(text) = root["artifacts"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|a| a["parts"].as_array())
            .and_then(|p| p.first())
            .and_then(|p| p["text"].as_str())
        {
            return text.to_string();
        }
        if let Some(text) = root["status"]["message"]["parts"]
            .as_array()
            .and_then(|p| p.first())
            .and_then(|p| p["text"].as_str())
        {
            return text.to_string();
        }
    }
    if let Some(text) = json["result"]["parts"]
        .as_array()
        .and_then(|p| p.first())
        .and_then(|p| p["text"].as_str())
    {
        return text.to_string();
    }
    if let Some(text) = json["result"].as_str() {
        return text.to_string();
    }
    String::new()
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/// Mirrors Python's `_get_context`: produces one verbose block per completed step,
/// joined by blank lines, using 1-based step numbering to match Python exactly.
///
/// Format per step:
/// ```text
/// --- Step N (AgentName) ---
/// Prompt Template: <template>
/// User Prompt Sent: <actual_prompt>
/// Goal of Extraction: <to_extract>
/// Actual Extracted Information: <extracted_info>
/// ```
fn build_context(step_results: &[StepResult]) -> String {
    step_results
        .iter()
        .filter_map(|s| {
            s.extracted_info.as_deref().map(|info| {
                format!(
                    "--- Step {} ({}) ---\n\
                     Prompt Template: {}\n\
                     User Prompt Sent: {}\n\
                     Goal of Extraction: {}\n\
                     Actual Extracted Information: {}",
                    s.step_index + 1,
                    s.agent_name,
                    s.prompt_template,
                    s.prompt,
                    s.to_extract,
                    info,
                )
            })
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use nasiko_observability::{
        AgentFinOps, AgentStats, CostBreakdown, ObservabilityError, Session, SessionDetails, Span,
        SpanDetails, TraceDetails,
    };
    use std::collections::HashMap as StdHashMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A hand-rolled `ObservabilityProvider` test double. Only `get_trace` is
    /// exercised by `wait_for_agent_usage` — every other method is a
    /// never-called stub, required only because the trait has no default for
    /// them.
    struct MockProvider {
        /// `get_trace` returns `NotFound` for the first `fail_calls`
        /// invocations, then `trace` forever after.
        fail_calls: usize,
        calls: Arc<AtomicUsize>,
        trace: TraceDetails,
    }

    #[async_trait]
    impl ObservabilityProvider for MockProvider {
        async fn sessions_for_agent(
            &self,
            _: &str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<Vec<Session>, ObservabilityError> {
            Ok(vec![])
        }

        async fn get_session(
            &self,
            _: &str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<SessionDetails, ObservabilityError> {
            Err(ObservabilityError::NotFound("unused in these tests".into()))
        }

        async fn get_trace(&self, _trace_id: &str) -> Result<TraceDetails, ObservabilityError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.fail_calls {
                Err(ObservabilityError::NotFound("not exported yet".into()))
            } else {
                Ok(self.trace.clone())
            }
        }

        async fn get_span(&self, _: &str, _: &str) -> Result<SpanDetails, ObservabilityError> {
            Err(ObservabilityError::NotFound("unused in these tests".into()))
        }

        async fn agent_stats(
            &self,
            agent_id: &str,
            start: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<AgentStats, ObservabilityError> {
            Ok(AgentStats {
                agent_id: agent_id.to_string(),
                trace_count: 0,
                is_capped: false,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                model_used: None,
                latency_ms_p50: None,
                latency_ms_p99: None,
                cost: CostBreakdown::default(),
                period_start: start,
            })
        }

        async fn agent_finops(
            &self,
            agent_id: &str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<AgentFinOps, ObservabilityError> {
            Ok(AgentFinOps {
                agent_id: agent_id.to_string(),
                operations: 0,
                is_capped: false,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                model_used: None,
                latency_ms_p50: None,
                cost: CostBreakdown::default(),
            })
        }

        async fn count_user_traces(
            &self,
            _: &str,
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> Result<usize, ObservabilityError> {
            Ok(0)
        }

        async fn query_logs(
            &self,
            _: &str,
            _: Option<DateTime<Utc>>,
            _: Option<DateTime<Utc>>,
            _: usize,
        ) -> Result<Vec<(DateTime<Utc>, String)>, ObservabilityError> {
            Ok(vec![])
        }

        async fn cost(&self, _: Option<&str>, _: u64, _: u64) -> CostBreakdown {
            CostBreakdown::default()
        }
    }

    fn trace_with_tokens(input: u64, output: u64, model: Option<&str>) -> TraceDetails {
        let mut attrs: StdHashMap<String, serde_json::Value> = StdHashMap::new();
        attrs.insert(
            "gen_ai.usage.input_tokens".to_string(),
            serde_json::json!(input),
        );
        attrs.insert(
            "gen_ai.usage.output_tokens".to_string(),
            serde_json::json!(output),
        );
        if let Some(m) = model {
            attrs.insert("gen_ai.request.model".to_string(), serde_json::json!(m));
        }
        let span = Span {
            span_id: "span-1".into(),
            parent_span_id: None,
            name: "chat".into(),
            started_at: Utc::now(),
            ended_at: None,
            duration_ms: Some(100),
            service_name: "test-agent".into(),
            kind: 2,
            status_code: 1,
            status_message: String::new(),
            attributes: attrs,
            events: vec![],
        };
        TraceDetails {
            trace_id: "trace-1".into(),
            spans: vec![span],
            started_at: Some(Utc::now()),
            ended_at: None,
            duration_ms: Some(100),
        }
    }

    fn trace_with_no_tokens() -> TraceDetails {
        let span = Span {
            span_id: "span-1".into(),
            parent_span_id: None,
            name: "infra".into(),
            started_at: Utc::now(),
            ended_at: None,
            duration_ms: Some(5),
            service_name: "test-agent".into(),
            kind: 1,
            status_code: 1,
            status_message: String::new(),
            attributes: StdHashMap::new(),
            events: vec![],
        };
        TraceDetails {
            trace_id: "trace-1".into(),
            spans: vec![span],
            started_at: Some(Utc::now()),
            ended_at: None,
            duration_ms: Some(5),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_agent_usage_returns_immediately_when_the_trace_is_found_on_the_first_poll() {
        let provider = MockProvider {
            fail_calls: 0,
            calls: Arc::new(AtomicUsize::new(0)),
            trace: trace_with_tokens(120, 80, Some("gpt-4o-mini")),
        };
        let usage = wait_for_agent_usage(&provider, "trace-1").await;
        assert_eq!(usage.input, 120);
        assert_eq!(usage.output, 80);
        assert_eq!(usage.model.as_deref(), Some("gpt-4o-mini"));
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "must not poll again once found"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_agent_usage_polls_through_transient_not_found_then_succeeds() {
        let provider = MockProvider {
            fail_calls: 4,
            calls: Arc::new(AtomicUsize::new(0)),
            trace: trace_with_tokens(50, 25, Some("claude-3-5-sonnet")),
        };
        let usage = wait_for_agent_usage(&provider, "trace-1").await;
        assert_eq!(usage.input, 50);
        assert_eq!(usage.output, 25);
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            5,
            "4 failed attempts + the 1 that finally succeeded"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_agent_usage_gives_up_after_ten_attempts_and_returns_zeroed_usage() {
        let provider = MockProvider {
            fail_calls: 999, // never succeeds
            calls: Arc::new(AtomicUsize::new(0)),
            trace: trace_with_tokens(1, 1, None),
        };
        let usage = wait_for_agent_usage(&provider, "trace-1").await;
        assert_eq!(usage.input, 0);
        assert_eq!(usage.output, 0);
        assert!(usage.model.is_none());
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            10,
            "must stop after exactly 10 poll attempts, not loop forever"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_agent_usage_keeps_polling_a_trace_that_exists_but_has_no_token_attributes() {
        // A real trace that exists (e.g. a non-LLM agent step) but never
        // reports tokens must NOT be mistaken for "found" — the loop's exit
        // condition is `input + output > 0`, not merely "the trace exists".
        let provider = MockProvider {
            fail_calls: 0,
            calls: Arc::new(AtomicUsize::new(0)),
            trace: trace_with_no_tokens(),
        };
        let usage = wait_for_agent_usage(&provider, "trace-1").await;
        assert_eq!(usage.input, 0);
        assert_eq!(usage.output, 0);
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            10,
            "a token-less trace must exhaust all 10 attempts, same as never-found"
        );
    }
}
