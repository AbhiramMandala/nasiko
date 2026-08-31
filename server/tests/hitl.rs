//! HTTP-level tests for the HITL resolve API — `GET /api/hitl/pending`,
//! `POST /api/hitl/{id}/resolve` (`oss/server/src/router/hitl.rs`, M5).
//!
//!   cargo test -p nasiko-server --test hitl -- --test-threads=1

mod common;

use serde_json::{Value, json};
use serial_test::serial;
use uuid::Uuid;

/// Seed a `users` row directly — the resolve API only needs a valid JWT
/// `sub`; it doesn't require any particular role.
async fn seed_user(server: &common::TestServer, username: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(username)
        .bind(format!("{username}@test.local"))
        .execute(&server.db)
        .await
        .unwrap();
    id
}

async fn seed_agent(server: &common::TestServer, owner_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO agents (id, name, owner_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
    )
    .bind(name)
    .bind(owner_id)
    .fetch_one(&server.db)
    .await
    .unwrap()
}

/// Insert a pending `hitl_requests` row directly (bypassing `nasiko_hitl::repo`,
/// which the HTTP layer under test also calls into — inserting independently
/// here keeps this an actual test of the HTTP surface, not a round-trip
/// through the same code).
#[allow(clippy::too_many_arguments)]
async fn seed_pending_tool_approval(
    server: &common::TestServer,
    agent_id: Uuid,
    owner_user_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    context_id: &str,
) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO hitl_requests
            (kind, origin, agent_id, owner_user_id, connector_id, tool_name, context_id, question)
        VALUES
            ('tool_approval', 'mcp_tool', $1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(agent_id)
    .bind(owner_user_id)
    .bind(connector_id)
    .bind(tool_name)
    .bind(context_id)
    .bind(json!({"tool_name": tool_name}))
    .fetch_one(&server.db)
    .await
    .unwrap()
}

#[tokio::test]
#[serial]
async fn list_pending_returns_only_the_callers_own_rows() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-1").await;
    let other = seed_user(&server, "hitl-other-1").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-1").await;

    seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;
    seed_pending_tool_approval(
        &server,
        agent_id,
        other,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-2",
    )
    .await;

    let res = common::as_member(
        server.client.get(server.url("/api/hitl/pending")),
        &owner.to_string(),
        "hitl-owner-1",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.json::<Value>().await.unwrap();
    let rows = body["data"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        1,
        "must only see the caller's own pending row: {rows:?}"
    );
    assert_eq!(rows[0]["owner_user_id"], json!(owner.to_string()));
    assert_eq!(rows[0]["status"], json!("pending"));

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn resolve_by_a_non_owner_is_forbidden() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-2").await;
    let other = seed_user(&server, "hitl-other-2").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-2").await;
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &other.to_string(),
        "hitl-other-2",
    )
    .json(&json!({"decision": "approve"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 403);

    let status: String = sqlx::query_scalar("SELECT status FROM hitl_requests WHERE id = $1")
        .bind(request_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        status, "pending",
        "a forbidden attempt must not mutate the row"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn owner_can_approve_a_pending_request() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-3").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-3").await;
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-3",
    )
    .json(&json!({"decision": "approve", "note": "looks fine"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);
    let body = res.json::<Value>().await.unwrap();
    assert_eq!(body["data"]["status"], json!("resolved"));
    assert_eq!(body["data"]["resolved_by"], json!(owner.to_string()));

    let (status, resolved_by, human_response): (String, Option<Uuid>, Value) = sqlx::query_as(
        "SELECT status, resolved_by, human_response FROM hitl_requests WHERE id = $1",
    )
    .bind(request_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(status, "resolved");
    assert_eq!(resolved_by, Some(owner));
    assert_eq!(human_response["decision"], json!("approve"));
    assert_eq!(human_response["note"], json!("looks fine"));

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn owner_can_reject_a_pending_request() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-4").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-4").await;
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-4",
    )
    .json(&json!({"decision": "reject"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);

    let status: String = sqlx::query_scalar("SELECT status FROM hitl_requests WHERE id = $1")
        .bind(request_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(status, "rejected");

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn resolving_an_already_resolved_request_returns_conflict() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-5").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-5").await;
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let first = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-5",
    )
    .json(&json!({"decision": "approve"}))
    .send()
    .await
    .unwrap();
    assert_eq!(first.status(), 200);

    let second = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-5",
    )
    .json(&json!({"decision": "reject"}))
    .send()
    .await
    .unwrap();
    assert_eq!(second.status(), 409);

    let status: String = sqlx::query_scalar("SELECT status FROM hitl_requests WHERE id = $1")
        .bind(request_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        status, "resolved",
        "the second (conflicting) attempt must not overwrite the first decision"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn resolving_an_unknown_id_returns_not_found() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-6").await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{}/resolve", Uuid::new_v4()))),
        &owner.to_string(),
        "hitl-owner-6",
    )
    .json(&json!({"decision": "approve"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 404);

    server.cleanup().await;
}

// ─── M7: scope=session creates a session grant ──────────────────────────────

#[tokio::test]
#[serial]
async fn approve_with_session_scope_creates_a_session_grant() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-7").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-7").await;
    let connector_id = Uuid::new_v4();
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-7",
    )
    .json(&json!({"decision": "approve", "scope": "session"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);

    let grant_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM mcp_session_tool_grants \
         WHERE agent_id = $1 AND connector_id = $2 AND tool_name = $3 AND context_id = $4",
    )
    .bind(agent_id)
    .bind(connector_id)
    .bind("GITHUB_DELETE_REPO")
    .bind("ctx-1")
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(
        grant_count, 1,
        "approving with scope=session must record exactly one session grant"
    );

    let human_response: Value =
        sqlx::query_scalar("SELECT human_response FROM hitl_requests WHERE id = $1")
            .bind(request_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(human_response["scope"], json!("session"));

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn approve_without_scope_defaults_to_once_and_creates_no_grant() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-8").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-8").await;
    let request_id = seed_pending_tool_approval(
        &server,
        agent_id,
        owner,
        Uuid::new_v4(),
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await;

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-8",
    )
    .json(&json!({"decision": "approve"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);

    let human_response: Value =
        sqlx::query_scalar("SELECT human_response FROM hitl_requests WHERE id = $1")
            .bind(request_id)
            .fetch_one(&server.db)
            .await
            .unwrap();
    assert_eq!(human_response["scope"], json!("once"));

    let grant_count: i64 = sqlx::query_scalar("SELECT count(*) FROM mcp_session_tool_grants")
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        grant_count, 0,
        "the default once-scope approval must never create a session grant"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn session_scope_is_rejected_for_a_non_tool_approval_kind() {
    let server = common::TestServer::start().await;
    let owner = seed_user(&server, "hitl-owner-9").await;
    let agent_id = seed_agent(&server, owner, "hitl-test-agent-9").await;

    let request_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO hitl_requests
            (kind, origin, agent_id, owner_user_id, connector_id, context_id, question)
        VALUES
            ('auth_required', 'mcp_tool', $1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(agent_id)
    .bind(owner)
    .bind(Uuid::new_v4())
    .bind("ctx-1")
    .bind(json!({"connector": "github"}))
    .fetch_one(&server.db)
    .await
    .unwrap();

    let res = common::as_member(
        server
            .client
            .post(server.url(&format!("/api/hitl/{request_id}/resolve"))),
        &owner.to_string(),
        "hitl-owner-9",
    )
    .json(&json!({"decision": "approve", "scope": "session"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 400);

    let status: String = sqlx::query_scalar("SELECT status FROM hitl_requests WHERE id = $1")
        .bind(request_id)
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        status, "pending",
        "a rejected scope must not mutate the row"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn unauthenticated_requests_are_rejected() {
    let server = common::TestServer::start().await;

    let res = server
        .client
        .get(server.url("/api/hitl/pending"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    server.cleanup().await;
}
