/**
 * The prompts offered on an empty Weave surface — in the dock and on /weave.
 *
 * ## Why a shared module
 *
 * There were two lists and they drifted. /weave's was updated to things the
 * generator can actually answer; the dock's was not, and went on offering
 * "Help me configure an LLM provider" and "Create a new agent" — two requests
 * with no data source behind them, so the correct answer to both is a sentence
 * of prose declining (agent.yaml rule 11). A starter that cannot be answered
 * is worse than no starter: it is the product promising something, in a
 * button, on the first screen anyone sees, and then refusing.
 *
 * One list is not a tidiness preference. The drift is what produced the bad
 * copy, and two lists will drift again the next time the scope moves.
 *
 * ## What belongs here
 *
 * Only TokenOps. That is the entire scope the generator has — seven sources,
 * all spend, tokens, operations and latency (surface/data-manifest.json).
 * Anything outside it gets a correct refusal, which reads to a first-time user
 * as the feature being broken.
 *
 * And only shapes that are known to generate well. Every string below is a
 * prompt from the eval suite (scripts/eval-generations.mjs) that passes
 * against a recorded generation, and surface-starters.test.mjs asserts that —
 * so a starter cannot be added here on the strength of sounding good. That is
 * the same argument the prompt work landed on: demonstrated beats described.
 *
 * The four answer four different shapes, deliberately. A menu of four
 * breakdowns teaches the reader that breakdowns are all this does.
 */
export const WEAVE_STARTERS = [
  // Breadth: two sources, two chart kinds, KPIs and a table. The case that
  // took five attempts to make pass, and the one worth leading with, because
  // it is the shape that shows what the surface can do. (eval: comprehensive)
  'Create a comprehensive TokenOps dashboard with charts',
  // A breakdown — one row per agent, and the ranking chart over it.
  // (eval: agents-table)
  'Which agents cost the most? Table, with a cost breakdown',
  // A series — two measures over time, the one shape a line chart is for.
  // (eval: spend-14d)
  'Show me spend and request volume for the last 14 days',
  // Interactive: $state, an Action and a re-fetch — the half of the DSL the
  // other three never reach. (eval: interactive-controls)
  'Cost dashboard with a search box and buttons to change the window',
];
