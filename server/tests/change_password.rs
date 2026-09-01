//! Self-service password change (`POST /api/auth/change-password`).
//!
//! The behaviour that matters here is that this route is reachable *without*
//! superuser: before it existed, the only way to set a password was
//! `PUT /api/users/{id}`, which sits behind `require_superuser`, so no ordinary
//! user — and, because the UI blanked superuser rows, not even the admin —
//! could rotate their own credential.

mod common;

use common::{as_member, as_superuser};
use serde_json::{Value, json};
use serial_test::serial;
use uuid::Uuid;

async fn init_admin(server: &common::TestServer) -> Value {
    server
        .client
        .post(server.url("/api/auth/initialize-admin"))
        .json(&json!({"username": "admin", "email": "admin@test.local"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()
}

/// Raw login status — these tests care about rejection, not the body.
async fn login_status(
    server: &common::TestServer,
    username: &str,
    password: &str,
) -> reqwest::StatusCode {
    server
        .client
        .post(server.url("/api/auth/login"))
        .json(&json!({"username": username, "password": password}))
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
#[serial]
async fn change_password_rotates_the_credential() {
    let server = common::TestServer::start().await;
    let admin = init_admin(&server).await;
    let id = admin["user_id"].as_str().unwrap();
    let old = admin["access_secret"].as_str().unwrap();

    let res = as_superuser(
        server.client.post(server.url("/api/auth/change-password")),
        id,
        "admin",
    )
    .json(&json!({"current_password": old, "new_password": "a-brand-new-password"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200, "change should succeed");

    assert_eq!(
        login_status(&server, "admin", old).await,
        401,
        "the replaced password must stop working"
    );
    assert_eq!(
        login_status(&server, "admin", "a-brand-new-password").await,
        200,
        "the new password must work"
    );
}

#[tokio::test]
#[serial]
async fn change_password_rejects_a_wrong_current_password() {
    let server = common::TestServer::start().await;
    let admin = init_admin(&server).await;
    let id = admin["user_id"].as_str().unwrap();
    let old = admin["access_secret"].as_str().unwrap();

    let res = as_superuser(
        server.client.post(server.url("/api/auth/change-password")),
        id,
        "admin",
    )
    .json(&json!({"current_password": "not-the-password", "new_password": "another-password"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 401);

    // The credential must be untouched after a failed attempt.
    assert_eq!(login_status(&server, "admin", old).await, 200);
}

#[tokio::test]
#[serial]
async fn change_password_enforces_minimum_length_and_difference() {
    let server = common::TestServer::start().await;
    let admin = init_admin(&server).await;
    let id = admin["user_id"].as_str().unwrap();
    let old = admin["access_secret"].as_str().unwrap();

    let short = as_superuser(
        server.client.post(server.url("/api/auth/change-password")),
        id,
        "admin",
    )
    .json(&json!({"current_password": old, "new_password": "short"}))
    .send()
    .await
    .unwrap();
    assert_eq!(short.status(), 400, "under 8 characters must be rejected");

    let same = as_superuser(
        server.client.post(server.url("/api/auth/change-password")),
        id,
        "admin",
    )
    .json(&json!({"current_password": old, "new_password": old}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        same.status(),
        400,
        "reusing the current password is rejected"
    );
}

/// The regression this feature exists for: a non-superuser can rotate their own
/// credential. Every pre-existing password-setting path required superuser.
#[tokio::test]
#[serial]
async fn a_non_superuser_can_change_their_own_password() {
    let server = common::TestServer::start().await;
    let admin = init_admin(&server).await;
    let admin_id = admin["user_id"].as_str().unwrap();

    let alice = as_superuser(
        server.client.post(server.url("/api/users")),
        admin_id,
        "admin",
    )
    .json(&json!({"username": "alice", "email": "alice@test.local"}))
    .send()
    .await
    .unwrap()
    .json::<Value>()
    .await
    .unwrap();

    let alice_id = alice["user_id"]
        .as_str()
        .or_else(|| alice["id"].as_str())
        .expect("create_user returns the new user id");
    let alice_secret = alice["access_secret"].as_str().unwrap();

    let res = as_member(
        server.client.post(server.url("/api/auth/change-password")),
        alice_id,
        "alice",
    )
    .json(&json!({"current_password": alice_secret, "new_password": "alice-new-password"}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        res.status(),
        200,
        "a member must be able to change their own password"
    );

    assert_eq!(
        login_status(&server, "alice", "alice-new-password").await,
        200
    );
}

/// SSO-provisioned users are inserted with no `user_credentials` row. That must
/// read as a 409 ("no local password"), not a 500 — it becomes reachable the
/// moment an identity provider is wired up.
#[tokio::test]
#[serial]
async fn user_without_local_credentials_gets_a_conflict() {
    let server = common::TestServer::start().await;
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO users (id, username, email, is_superuser, is_active, role)
         VALUES ($1, 'sso-user', 'sso@test.local', false, true, 'member'::user_role)",
    )
    .bind(id)
    .execute(&server.db)
    .await
    .unwrap();

    let res = as_member(
        server.client.post(server.url("/api/auth/change-password")),
        &id.to_string(),
        "sso-user",
    )
    .json(&json!({"current_password": "anything", "new_password": "a-valid-password"}))
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 409);
}

#[tokio::test]
#[serial]
async fn change_password_requires_authentication() {
    let server = common::TestServer::start().await;
    let res = server
        .client
        .post(server.url("/api/auth/change-password"))
        .json(&json!({"current_password": "x", "new_password": "a-valid-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}
