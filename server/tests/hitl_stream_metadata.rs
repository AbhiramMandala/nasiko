//! End-to-end tests for the Direct Chat pause-ordering fix (`a2a_dispatch.rs::agent_stream`,
//! `persist_direct_chat_pause`, `build_hitl_stream_event`) and the session-load HITL discovery
//! path (`chat/routes.rs::list_messages`).
//!
//! What these prove, concretely:
//!   1. The synthetic `"type":"hitl"` frame the live A2A stream carries always names a row that
//!      already exists in Postgres by the time the frame is observable — the id cannot be
//!      minted before `hitl_store.create()` returns `Ok`, so a client reading this id off the
//!      wire and immediately querying the DB will always find it.
//!   2. `input_required` and `auth_required` both produce this frame, with the right `kind`.
//!   3. `GET /chat/sessions/{id}/messages` (session load) surfaces a pending HITL without the
//!      caller ever touching `/api/hitl/pending`, and only to its owner.
//!   4. A second pause on the same task/context gets its own, distinct `hitl_requests.id`.
//!
//! Requires infra (Postgres, Redis) like the rest of the suite:
//!   `just infra` then `cargo test -p nasiko-server --test hitl_stream_metadata -- --test-threads=1`

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{Router, extract::State, routing::post};
use serde_json::{Value, json};
use serial_test::serial;
use uuid::Uuid;

fn auth(rb: reqwest::RequestBuilder, user_id: Uuid) -> reqwest::RequestBuilder {
    let user_id_str = user_id.to_string();
    common::as_member(rb, &user_id_str, &format!("user_{}", &user_id_str[..8]))
}

async fn seed_user(server: &common::TestServer, user_id: Uuid) {
    sqlx::query(
        "INSERT INTO users (id, username, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(format!("user_{}", &user_id.to_string()[..8]))
    .bind(format!("user_{}@test.example", &user_id.to_string()[..8]))
    .execute(&server.db)
    .await
    .expect("seed_user");
}

async fn seed_running_agent(server: &common::TestServer, owner_id: Uuid, url: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO agents (name, owner_id, url, status) VALUES ($1, $2, $3, 'running') RETURNING id",
    )
    .bind(format!("hitl-stream-test-agent-{}", Uuid::new_v4()))
    .bind(owner_id)
    .bind(url)
    .fetch_one(&server.db)
    .await
    .expect("seed_running_agent")
}

/// A minimal A2A fixture agent: each call consumes the next entry in `responses` (the last entry
/// repeats once exhausted), so one mock server can script "pause, then pause again on resume"
/// without a real agent SDK.
#[derive(Clone)]
struct MockAgent {
    responses: Arc<Vec<MockResponse>>,
    call_count: Arc<AtomicUsize>,
}

enum MockResponse {
    /// Streaming (`text/event-stream`) input-required/auth-required pause frame.
    Pause { auth: bool, message: &'static str },
}

async fn mock_agent_handler(
    State(agent): State<MockAgent>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let idx = agent.call_count.fetch_add(1, Ordering::SeqCst);
    let req: Value = serde_json::from_slice(&body).unwrap_or_default();
    let task_id = req["params"]["message"]["taskId"]
        .as_str()
        .unwrap_or("mock-task")
        .to_string();
    let context_id = req["params"]["message"]["contextId"]
        .as_str()
        .unwrap_or("mock-ctx")
        .to_string();

    let response = agent
        .responses
        .get(idx)
        .or_else(|| agent.responses.last())
        .expect("MockAgent must be given at least one response");

    let MockResponse::Pause { auth, message } = response;
    let status = if *auth {
        nasiko_types::a2a::auth_required(&task_id, &context_id, message)
    } else {
        nasiko_types::a2a::input_required(&task_id, &context_id, message)
    };
    let event = nasiko_types::a2a::status_event(status);

    let sse_body = format!("data: {}\n\n", nasiko_types::a2a::to_sse_data(&event));
    axum::response::Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from(sse_body))
        .unwrap()
}

/// Starts the fixture agent on a random port. The returned `JoinHandle` must be kept alive
/// (bound to a variable, not `_`) for as long as the test needs the agent reachable.
async fn start_mock_agent(responses: Vec<MockResponse>) -> (String, tokio::task::JoinHandle<()>) {
    let agent = MockAgent {
        responses: Arc::new(responses),
        call_count: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/", post(mock_agent_handler))
        .with_state(agent);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), handle)
}

/// Drives one real `POST /api/orchestrator/a2a` turn against the given agent — the exact request
/// shape `chat-page.js` sends, `metadata.agent_id`/`metadata.session_id` included, so this
/// exercises the real dispatch-routing decision (into `agent_stream`, not `orchestrator_stream`)
/// and the real session-tagging path this session's changes added. Scans the raw SSE body for
/// the synthetic `"type":"hitl"` data part the pause path now emits and returns its parsed JSON
/// (panics if the stream never carries one).
async fn send_turn_and_extract_hitl_frame(
    server: &common::TestServer,
    user_id: Uuid,
    agent_id: Uuid,
    session_id: &str,
    context_id: &str,
    text: &str,
) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": Uuid::new_v4().to_string(),
        "method": "message/stream",
        "params": {
            "message": {
                "messageId": Uuid::new_v4().to_string(),
                "contextId": context_id,
                "role": "ROLE_USER",
                "parts": [{"text": text}],
            },
            "metadata": {"agent_id": agent_id.to_string(), "session_id": session_id},
        },
    });

    let res = auth(
        server
            .client
            .post(server.url("/api/orchestrator/a2a"))
            .json(&body),
        user_id,
    )
    .send()
    .await
    .expect("a2a turn request failed");
    assert!(
        res.status().is_success(),
        "a2a turn returned {}",
        res.status()
    );
    let raw = res.text().await.expect("read a2a stream body");

    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let parts = parsed
            .pointer("/statusUpdate/status/message/parts")
            .or_else(|| parsed.pointer("/result/statusUpdate/status/message/parts"));
        if let Some(parts) = parts.and_then(|p| p.as_array()) {
            for part in parts {
                if let Some(d) = part.get("data")
                    && d.get("type").and_then(|v| v.as_str()) == Some("hitl")
                {
                    return d.clone();
                }
            }
        }
    }
    panic!("no \"type\":\"hitl\" frame found in stream:\n{raw}");
}

/// The ordering guarantee, proven empirically rather than just structurally: the `id` read off
/// the wire must already correspond to a real `pending` row — if `build_hitl_stream_event` had
/// run before `hitl_store.create()` returned `Ok` (the bug this branch fixes), there would be no
/// row for this id to find, and `fetch_one` below would panic.
#[tokio::test]
#[serial]
async fn input_required_pause_stream_frame_names_an_already_persisted_row() {
    let server = common::TestServer::start().await;
    let user_id = Uuid::new_v4();
    seed_user(&server, user_id).await;

    let (agent_url, _agent_handle) = start_mock_agent(vec![MockResponse::Pause {
        auth: false,
        message: "Which movie would you like to watch?",
    }])
    .await;
    let agent_id = seed_running_agent(&server, user_id, &agent_url).await;

    let session_id = format!("ses_{}", Uuid::new_v4().simple());
    let context_id = session_id.clone();
    let hitl_frame = send_turn_and_extract_hitl_frame(
        &server,
        user_id,
        agent_id,
        &session_id,
        &context_id,
        "Book me a movie ticket",
    )
    .await;

    assert_eq!(hitl_frame["kind"], "input_required");
    assert_eq!(hitl_frame["context_id"], context_id);
    let hitl_id: Uuid = hitl_frame["id"].as_str().unwrap().parse().unwrap();

    // Query the row directly — proves it was durably committed before this id could ever have
    // been observed on the wire.
    let (status, kind, agent_id_col, task_id): (String, String, Uuid, Option<String>) =
        sqlx::query_as("SELECT status, kind, agent_id, task_id FROM hitl_requests WHERE id = $1")
            .bind(hitl_id)
            .fetch_one(&server.db)
            .await
            .expect("the id from the stream must already exist in hitl_requests");
    assert_eq!(status, "pending");
    assert_eq!(kind, "input_required");
    assert_eq!(agent_id_col, agent_id);
    assert_eq!(task_id.as_deref(), hitl_frame["task_id"].as_str());

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn auth_required_pause_stream_frame_carries_matching_kind() {
    let server = common::TestServer::start().await;
    let user_id = Uuid::new_v4();
    seed_user(&server, user_id).await;

    let (agent_url, _agent_handle) = start_mock_agent(vec![MockResponse::Pause {
        auth: true,
        message: "Reply \"authorized\" once you've granted access.",
    }])
    .await;
    let agent_id = seed_running_agent(&server, user_id, &agent_url).await;

    let session_id = format!("ses_{}", Uuid::new_v4().simple());
    let hitl_frame = send_turn_and_extract_hitl_frame(
        &server,
        user_id,
        agent_id,
        &session_id,
        &session_id,
        "Connect my GitHub account",
    )
    .await;

    assert_eq!(hitl_frame["kind"], "auth_required");
    let hitl_id: Uuid = hitl_frame["id"].as_str().unwrap().parse().unwrap();
    let kind: String = sqlx::query_scalar("SELECT kind FROM hitl_requests WHERE id = $1")
        .bind(hitl_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(kind, "auth_required");

    server.cleanup().await;
}

/// Session-load HITL discovery: the pending row created by a live pause shows up in
/// `GET /chat/sessions/{id}/messages` without the caller ever calling `/api/hitl/pending`, and
/// only for its own owner — a second user's identical request must not see it (their own
/// `owns` check 404s before the HITL query even runs).
#[tokio::test]
#[serial]
async fn session_messages_surfaces_pending_hitl_only_to_its_owner() {
    let server = common::TestServer::start().await;
    let owner_id = Uuid::new_v4();
    let other_id = Uuid::new_v4();
    seed_user(&server, owner_id).await;
    seed_user(&server, other_id).await;

    let (agent_url, _agent_handle) = start_mock_agent(vec![MockResponse::Pause {
        auth: false,
        message: "Which venue?",
    }])
    .await;
    let agent_id = seed_running_agent(&server, owner_id, &agent_url).await;

    // A real session row (create_session's own path), owned by `owner_id`.
    let session_id = format!("ses_{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO chat_sessions (session_id, user_id, agent_id, title) VALUES ($1, $2, $3, 'test')",
    )
    .bind(&session_id)
    .bind(owner_id)
    .bind(agent_id)
    .execute(&server.db)
    .await
    .unwrap();

    let hitl_frame = send_turn_and_extract_hitl_frame(
        &server,
        owner_id,
        agent_id,
        &session_id,
        &session_id,
        "Book a table",
    )
    .await;
    let hitl_id = hitl_frame["id"].as_str().unwrap().to_string();

    // Owner sees it on session load.
    let owner_res: Value = auth(
        server
            .client
            .get(server.url(&format!("/api/chat/sessions/{session_id}/messages"))),
        owner_id,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let owner_hitl = owner_res["hitl"].as_array().expect("hitl field present");
    assert!(
        owner_hitl.iter().any(|h| h["id"] == hitl_id),
        "owner's session-load response must include the pending HITL: {owner_res}"
    );
    assert_eq!(owner_hitl[0]["status"], "pending");

    // A different user can't even load this session (owns() check), so they can never reach
    // its HITL data through this endpoint.
    let other_res = auth(
        server
            .client
            .get(server.url(&format!("/api/chat/sessions/{session_id}/messages"))),
        other_id,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(other_res.status(), 404);

    server.cleanup().await;
}

/// Multiple sequential HITLs on the same task/context: the second pause (surfaced after the
/// dispatcher resumes the first one) gets a distinct `hitl_requests.id`, while `task_id`/
/// `context_id` stay identical — the correlation key the whole resume chain relies on.
#[tokio::test]
#[serial]
async fn sequential_pauses_on_same_task_get_distinct_hitl_ids() {
    let server = common::TestServer::start().await;
    let user_id = Uuid::new_v4();
    seed_user(&server, user_id).await;

    let (agent_url, _agent_handle) = start_mock_agent(vec![
        MockResponse::Pause {
            auth: false,
            message: "Which movie?",
        },
        MockResponse::Pause {
            auth: false,
            message: "Which venue?",
        },
    ])
    .await;
    let agent_id = seed_running_agent(&server, user_id, &agent_url).await;

    let session_id = format!("ses_{}", Uuid::new_v4().simple());
    let first = send_turn_and_extract_hitl_frame(
        &server,
        user_id,
        agent_id,
        &session_id,
        &session_id,
        "Book me a movie ticket",
    )
    .await;
    let first_id = first["id"].as_str().unwrap().to_string();
    let task_id = first["task_id"].as_str().unwrap().to_string();

    // Answer round 1 — the resume dispatcher calls the (scripted) agent again, which pauses a
    // second time; poll for the follow-up row rather than racing the dispatcher's poll tick.
    auth(
        server
            .client
            .post(server.url(&format!("/api/hitl/{first_id}/resolve")))
            .json(&json!({"answer": "Interstellar"})),
        user_id,
    )
    .send()
    .await
    .unwrap();

    let mut second_id: Option<String> = None;
    for _ in 0..40 {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT id::text FROM hitl_requests WHERE task_id = $1 AND id::text <> $2",
        )
        .bind(&task_id)
        .bind(&first_id)
        .fetch_optional(&server.db)
        .await
        .unwrap();
        if let Some((id,)) = row {
            second_id = Some(id);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let second_id = second_id.expect("a follow-up hitl_requests row for the second pause");
    assert_ne!(first_id, second_id, "each pause must get its own row id");

    let (second_task_id, second_context_id): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT task_id, context_id FROM hitl_requests WHERE id = $1::uuid")
            .bind(&second_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(second_task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(second_context_id.as_deref(), Some(session_id.as_str()));

    let first_row_status: String =
        sqlx::query_scalar("SELECT status FROM hitl_requests WHERE id = $1::uuid")
            .bind(&first_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(
        first_row_status, "resolved",
        "the first round's row stays as a resolved audit record, not reused or overwritten"
    );

    server.cleanup().await;
}
