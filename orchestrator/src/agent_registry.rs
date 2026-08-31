use sqlx::PgPool;
use uuid::Uuid;

use crate::error::RouterError;
use crate::types::AgentCard;

pub async fn get_agents_for_user(
    user_id: Uuid,
    pool: &PgPool,
) -> Result<Vec<AgentCard>, RouterError> {
    let rows = sqlx::query_as::<_, AgentRow>(
        r#"SELECT a.id, a.name, a.description, a.skills, a.tags, a.url,
                  a.embedding, a.embedding_content_hash
           FROM agents a
           LEFT JOIN agent_grants g ON g.agent_id = a.id
           WHERE a.status = 'running'
             AND (a.owner_id = $1 OR a.is_public = true OR g.grantee_id = $1::text)
           GROUP BY a.id"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| AgentCard {
            id: r.id,
            name: r.name,
            description: r.description.unwrap_or_default(),
            skills: extract_skill_names(r.skills.0),
            tags: r.tags,
            url: r.url,
            embedding: r
                .embedding
                .map(|v| v.into_iter().map(|f| f as f32).collect()),
            embedding_content_hash: r.embedding_content_hash,
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct AgentRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    skills: sqlx::types::Json<serde_json::Value>,
    tags: Vec<String>,
    url: Option<String>,
    embedding: Option<Vec<f64>>,
    embedding_content_hash: Option<i64>,
}

fn extract_skill_names(skills_json: serde_json::Value) -> Vec<String> {
    if let Some(arr) = skills_json.as_array() {
        arr.iter()
            .filter_map(|s| s.get("name").and_then(|n| n.as_str()).map(String::from))
            .collect()
    } else {
        vec![]
    }
}
