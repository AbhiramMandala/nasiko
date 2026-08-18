//! Per-agent gateway credentials (`MCP_GATEWAY_TOKEN`) — the agent-identity
//! half of the gateway's two-factor auth (docs/MCP_GATEWAY_AGENT_AUTH.md §2.2).
//!
//! Minted at deploy time and injected into the container env; the agent
//! presents it as `Authorization: Bearer <token>` on every `/api/mcp` call.
//! Only the SHA-256 hex hash is stored (`agent_gateway_tokens`, mirroring
//! `oci_pull_credentials`); the plaintext exists solely in the container env.
//! Every deploy/restart rotates the credential — env vars can't be recovered,
//! so re-minting on redeploy doubles as free rotation. Destroy tombstones it.

use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

/// SHA-256 hex digest — the stored form of a gateway token.
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Mint a fresh gateway token for `agent_id`, replacing any previous one
/// (rotate-on-deploy: the old plaintext lives only in the container env being
/// replaced, so there is nothing worth keeping). Returns the plaintext exactly
/// once — the caller must inject it into the deployment env immediately.
pub async fn mint(db: &PgPool, agent_id: Uuid) -> Result<String, sqlx::Error> {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    let token = format!("ngt_{}", hex::encode(buf));

    sqlx::query(
        "INSERT INTO agent_gateway_tokens (agent_id, token_hash)
         VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET
             token_hash = EXCLUDED.token_hash,
             created_at = now(),
             revoked_at = NULL",
    )
    .bind(agent_id)
    .bind(hash_token(&token))
    .execute(db)
    .await?;

    Ok(token)
}

/// Resolve a presented bearer token to its agent, if it matches a live
/// (non-revoked) credential. `None` = unknown or revoked → the caller must
/// answer 401.
pub async fn authenticate(db: &PgPool, token: &str) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT agent_id FROM agent_gateway_tokens
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(hash_token(token))
    .fetch_optional(db)
    .await
}

/// Tombstone an agent's gateway credential (agent destroy path). No-op when
/// none exists — destroy must be safe to re-run.
pub async fn revoke(db: &PgPool, agent_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE agent_gateway_tokens SET revoked_at = now()
         WHERE agent_id = $1 AND revoked_at IS NULL",
    )
    .bind(agent_id)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::hash_token;

    #[test]
    fn hash_is_stable_hex_sha256() {
        // Locks the storage convention: lowercase hex SHA-256 of the raw bytes.
        assert_eq!(
            hash_token("ngt_test"),
            "7e23252e185ed0461e4a4ec05c041e3c5904e12e5bede624b84ef5e9b141b1e7"
        );
    }
}
