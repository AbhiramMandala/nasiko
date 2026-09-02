//! `POST /api/weave/surface` — the control plane's proxy to the Weave
//! generation service.
//!
//! The browser must never hold the Weave internal token. Before this existed
//! the only way to reach the generator was for the page to call it directly
//! with the shared secret in its own source, which is exactly the defect
//! NAS-455 was filed for; the interim workaround put the token in
//! `localStorage` under `weave-direct`, which is a development convenience and
//! not a deployment. This route is the real answer: the secret lives in server
//! configuration, the caller is an authenticated control-plane user, and the
//! `text/event-stream` comes back over the same origin the page was served
//! from.
//!
//! The upstream body is *rebuilt* from a typed struct rather than forwarded as
//! received. A proxy that passes bytes through is a hole in whatever the
//! generator trusts about its input: an unknown field the client invents today
//! becomes a field the generator honours tomorrow, and nothing in between
//! would have noticed. Only `prompt`, `catalogVersion` and `currentSurface`
//! cross this boundary, and the data-source scope stays where it is decided —
//! in the generator, not in anything the browser can say.

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Claims;
use crate::state::AppState;

/// A generation turn can legitimately think for a while before its first
/// token, and the shared `state.http_client` carries a blanket 60s timeout
/// that would cut the stream mid-dashboard. This bounds the whole turn
/// instead — long enough for a slow model, short enough that a wedged
/// upstream does not pin a connection for the life of the process.
const TURN_TIMEOUT_SECS: u64 = 600;

/// A prompt is a sentence or two. Anything at this scale is either a mistake
/// or someone using the generator as a way to spend tokens against a model
/// they do not otherwise have access to.
const MAX_PROMPT_BYTES: usize = 8 * 1024;

/// The previous turn's DSL. The client prunes it to what is reachable before
/// sending, so a real surface is a few kilobytes; this is the ceiling on a
/// pathological one, not a target.
const MAX_SURFACE_BYTES: usize = 256 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/weave/surface", post(surface))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SurfaceRequest {
    prompt: String,
    #[serde(default)]
    context: SurfaceContext,
}

/// Unknown keys are accepted and discarded rather than rejected. `context` is
/// the client's own extension point — `weave-surface.js` documents it as
/// "whatever else the backend grows" — and a 400 on a key this build has not
/// heard of would make every frontend change wait on a server deploy. The
/// boundary is enforced by rebuilding the upstream body from these fields, not
/// by refusing to parse: a key nothing here reads simply never crosses.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SurfaceContext {
    /// The catalog the browser will actually render with. The generator
    /// treats it as the authority and refetches if it holds anything else,
    /// which is what closes the window where a deploy lands between its
    /// catalog fetch and this request.
    #[serde(default)]
    catalog_version: Option<String>,
    /// Raw DSL text of the previous turn, for a revision.
    #[serde(default)]
    current_surface: Option<String>,
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": message }))).into_response()
}

async fn surface(
    State(state): State<AppState>,
    claims: Claims,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // Parsed here rather than with the `Json` extractor so an unknown field
    // fails with something a frontend developer can act on. `deny_unknown_fields`
    // turning into a bare 422 is how a typo in a context key becomes an
    // afternoon.
    let req: SurfaceRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return bad_request(&format!("malformed request body: {e}")),
    };

    if req.prompt.trim().is_empty() {
        return bad_request("prompt is required");
    }
    if req.prompt.len() > MAX_PROMPT_BYTES {
        return bad_request("prompt is too long");
    }
    if req
        .context
        .current_surface
        .as_ref()
        .is_some_and(|s| s.len() > MAX_SURFACE_BYTES)
    {
        return bad_request("currentSurface is too long");
    }

    let token = state.config.weave_internal_token.trim();
    if token.is_empty() {
        tracing::error!("weave: WEAVE_INTERNAL_TOKEN is not configured; refusing to proxy");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({ "error": "weave generation is not configured on this deployment" })),
        )
            .into_response();
    }

    let target = format!(
        "{}/api/weave/surface",
        state.config.weave_base_url.trim_end_matches('/')
    );

    // Rebuilt, not forwarded. See the module comment.
    let upstream_body = json!({
        "prompt": req.prompt,
        "context": {
            "catalogVersion": req.context.catalog_version,
            "currentSurface": req.context.current_surface,
        },
    });

    let mut forwarded = state
        .http_client
        .post(&target)
        .timeout(std::time::Duration::from_secs(TURN_TIMEOUT_SECS))
        .header("x-weave-internal-token", token)
        .header("accept", "text/event-stream")
        .json(&upstream_body);

    // The client's resume loop replays from the last frame it saw. Weave does
    // not honour this yet — it restarts the generation, which the client
    // detects by the second `surface` frame and recovers from — but the header
    // has to reach it for the day it does.
    if let Some(last) = headers.get("last-event-id")
        && let Ok(value) = last.to_str()
    {
        forwarded = forwarded.header("last-event-id", value);
    }

    let response = match forwarded.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, %target, user = %claims.sub, "weave: upstream request failed");
            return (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({ "error": "the generation service is unreachable" })),
            )
                .into_response();
        }
    };

    let status = response.status();
    if !status.is_success() {
        // Upstream text is deliberately not relayed: a 401 from Weave means
        // *our* token is wrong, which is an operator problem, and echoing its
        // body to the browser tells a caller about the internal topology.
        tracing::error!(%status, %target, "weave: upstream returned an error status");
        return (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": "the generation service rejected the request" })),
        )
            .into_response();
    }

    tracing::info!(user = %claims.sub, "weave: streaming a generation turn");

    match Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        // Without these an intermediary is free to buffer the whole stream and
        // deliver it as one lump, which turns a dashboard that draws as it
        // arrives into a blank page followed by everything at once.
        .header("cache-control", "no-cache, no-transform")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(response.bytes_stream()))
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "weave: failed to build the streamed response");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
