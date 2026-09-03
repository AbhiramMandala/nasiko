//! Regression tests for persisting `--writable` on the deploy on-ramps other
//! than upload.
//!
//! `POST /api/containers` used to mount the volume without recording it, so
//! every later restart/update/rollback — all of which read the flag back from
//! the `agents` row — silently dropped the mount. `POST /api/github/clone` had
//! no way to express it at all.
//!
//! Requires infra (Postgres :5432, Redis, S3):
//!   cargo test -p nasiko-server --test writable_deploy -- --test-threads=1

mod common;

use serde_json::{Value, json};
use serial_test::serial;
use uuid::Uuid;

async fn init_admin(server: &common::TestServer) -> Uuid {
    let body: Value = server
        .client
        .post(server.url("/api/auth/initialize-admin"))
        .json(&json!({"username": "admin", "email": "admin@test.local"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    body["user_id"].as_str().unwrap().parse().unwrap()
}

async fn seed_agent(server: &common::TestServer, owner_id: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO agents (name, owner_id, image, status) \
         VALUES ($1, $2, 'nasiko/echo:1.0.0', 'running') RETURNING id",
    )
    .bind(name)
    .bind(owner_id)
    .fetch_one(&server.db)
    .await
    .unwrap()
}

async fn stored(server: &common::TestServer, agent_id: Uuid) -> (bool, Option<String>) {
    sqlx::query_as::<_, (bool, Option<String>)>(
        "SELECT writable, writable_path FROM agents WHERE id = $1",
    )
    .bind(agent_id)
    .fetch_one(&server.db)
    .await
    .unwrap()
}

async fn deploy(server: &common::TestServer, user_id: Uuid, body: Value) -> reqwest::Response {
    common::as_superuser(
        server.client.post(server.url("/api/containers")),
        &user_id.to_string(),
        "admin",
    )
    .json(&body)
    .send()
    .await
    .unwrap()
}

#[tokio::test]
#[serial]
async fn deploy_persists_writable_so_restart_keeps_the_mount() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;
    let agent_id = seed_agent(&server, uid, "wr-deploy").await;

    let res = deploy(
        &server,
        uid,
        json!({
            "image": "nasiko/echo:1.0.0",
            "name": "wr-deploy",
            "writable": true,
            "writable_path": "/app/data",
        }),
    )
    .await;
    assert!(
        res.status().is_success(),
        "deploy should succeed, got {}",
        res.status()
    );

    // The whole point: restart/update/rollback read these back from the row.
    let (writable, path) = stored(&server, agent_id).await;
    assert!(writable, "deploy --writable must persist writable=true");
    assert_eq!(path.as_deref(), Some("/app/data"));

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn deploy_without_the_field_keeps_stored_settings() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;
    let agent_id = seed_agent(&server, uid, "wr-keep").await;

    let res = deploy(
        &server,
        uid,
        json!({"image": "nasiko/echo:1.0.0", "name": "wr-keep", "writable": true}),
    )
    .await;
    assert!(res.status().is_success());

    // A plain `nasiko deploy` omits the field entirely (the CLI only sends it
    // when --writable was passed) — that must mean "unchanged", not "off".
    let res = deploy(
        &server,
        uid,
        json!({"image": "nasiko/echo:2.0.0", "name": "wr-keep"}),
    )
    .await;
    assert!(res.status().is_success());

    let (writable, _) = stored(&server, agent_id).await;
    assert!(
        writable,
        "omitting `writable` must keep the stored value, not clear it"
    );

    // Explicit false is still honored — carry-forward applies only to omission.
    let res = deploy(
        &server,
        uid,
        json!({"image": "nasiko/echo:3.0.0", "name": "wr-keep", "writable": false}),
    )
    .await;
    assert!(res.status().is_success());

    let (writable, _) = stored(&server, agent_id).await;
    assert!(!writable, "explicit writable=false must disable the mount");

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn deploy_rejects_an_invalid_writable_path() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;
    let agent_id = seed_agent(&server, uid, "wr-badpath").await;

    for bad in ["relative/path", "/", "/etc/../root", "/has:colon"] {
        let res = deploy(
            &server,
            uid,
            json!({
                "image": "nasiko/echo:1.0.0",
                "name": "wr-badpath",
                "writable_path": bad,
            }),
        )
        .await;
        assert_eq!(
            res.status(),
            400,
            "`{bad}` must be rejected at the request boundary, not as a 500 later"
        );
    }

    let (writable, path) = stored(&server, agent_id).await;
    assert!(!writable, "a rejected request must not have persisted");
    assert_eq!(path, None);

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn github_clone_rejects_an_invalid_writable_path() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;

    let res = common::as_superuser(
        server.client.post(server.url("/api/github/clone")),
        &uid.to_string(),
        "admin",
    )
    .json(&json!({
        "repository_full_name": "acme/my-agent",
        "writable_path": "not-absolute",
    }))
    .send()
    .await
    .unwrap();

    // 503 when GitHub OAuth isn't configured in the test env — either way it
    // must never be a 500 from deep in the runtime.
    assert!(
        res.status() == 400 || res.status() == 503,
        "expected a 400 (bad path) or 503 (GitHub unconfigured), got {}",
        res.status()
    );

    server.cleanup().await;
}

/// The settings form prefills its toggle from `GET /api/agents/{id}` and then
/// submits it back, so a missing or differently-spelled key there reads as
/// "storage off" and detaches the volume on the next save. That response is a
/// hand-projected DTO with `rename_all = "camelCase"`, so both the presence
/// and the exact key names need pinning.
#[tokio::test]
#[serial]
async fn agent_detail_exposes_writable_with_snake_case_keys() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;
    let agent_id = seed_agent(&server, uid, "wr-detail").await;

    let res = common::as_superuser(
        server
            .client
            .put(server.url(&format!("/api/agents/{agent_id}"))),
        &uid.to_string(),
        "admin",
    )
    .json(&json!({"writable": true, "writable_path": "/data"}))
    .send()
    .await
    .unwrap();
    assert!(res.status().is_success());

    let body: Value = common::as_superuser(
        server
            .client
            .get(server.url(&format!("/api/agents/{agent_id}"))),
        &uid.to_string(),
        "admin",
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();

    let agent = &body["data"];
    assert_eq!(
        agent["writable"], true,
        "detail response must carry writable"
    );
    assert_eq!(
        agent["writable_path"], "/data",
        "must be `writable_path`, not the struct's camelCase default"
    );
    assert!(
        agent.get("writablePath").is_none(),
        "camelCase spelling would silently read as unset in the UI"
    );

    server.cleanup().await;
}

#[tokio::test]
#[serial]
async fn catalog_update_toggles_writable_and_resets_the_path() {
    let server = common::TestServer::start().await;
    let uid = init_admin(&server).await;
    let agent_id = seed_agent(&server, uid, "wr-settings").await;

    let put = |body: Value| {
        common::as_superuser(
            server
                .client
                .put(server.url(&format!("/api/agents/{agent_id}"))),
            &uid.to_string(),
            "admin",
        )
        .json(&body)
        .send()
    };

    let res = put(json!({"writable": true, "writable_path": "/data"}))
        .await
        .unwrap();
    assert!(res.status().is_success(), "got {}", res.status());
    assert_eq!(
        stored(&server, agent_id).await,
        (true, Some("/data".into()))
    );

    // Omitted fields leave the stored values alone.
    let res = put(json!({"description": "unrelated edit"})).await.unwrap();
    assert!(res.status().is_success());
    assert_eq!(
        stored(&server, agent_id).await,
        (true, Some("/data".into()))
    );

    // Empty string is the explicit "back to the default /workspace" signal.
    let res = put(json!({"writable_path": ""})).await.unwrap();
    assert!(res.status().is_success());
    assert_eq!(stored(&server, agent_id).await, (true, None));

    let res = put(json!({"writable": false})).await.unwrap();
    assert!(res.status().is_success());
    assert_eq!(stored(&server, agent_id).await, (false, None));

    let res = put(json!({"writable_path": "bad-relative"})).await.unwrap();
    assert_eq!(res.status(), 400, "invalid path must be rejected");

    server.cleanup().await;
}
