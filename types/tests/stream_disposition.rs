//! `classify_stream_disposition` — Phase 1 of the HITL plan (§8). Covers both wire dialects the
//! rest of `a2a.rs` already guards against (proto-style `TASK_STATE_*`, legacy lowercase,
//! JSONRPC-wrapped vs. bare) across all four `StreamDisposition` outcomes.

use nasiko_types::a2a::{StreamDisposition, classify_stream_disposition};
use serde_json::json;

#[test]
fn working_status_is_continue() {
    let data = json!({"statusUpdate": {"status": {"state": "TASK_STATE_WORKING"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Continue
    );
}

#[test]
fn submitted_status_is_continue() {
    let data = json!({"statusUpdate": {"status": {"state": "submitted"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Continue
    );
}

#[test]
fn proto_style_input_required_is_paused() {
    let data =
        json!({"statusUpdate": {"status": {"state": "TASK_STATE_INPUT_REQUIRED"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Paused
    );
}

#[test]
fn legacy_lowercase_input_required_is_paused() {
    let data = json!({"statusUpdate": {"status": {"state": "input-required"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Paused
    );
}

#[test]
fn proto_style_auth_required_is_paused() {
    let data =
        json!({"statusUpdate": {"status": {"state": "TASK_STATE_AUTH_REQUIRED"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Paused
    );
}

#[test]
fn legacy_lowercase_auth_required_is_paused() {
    let data = json!({"statusUpdate": {"status": {"state": "auth-required"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Paused
    );
}

#[test]
fn completed_is_completed() {
    let data = json!({"statusUpdate": {"status": {"state": "TASK_STATE_COMPLETED"}}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Completed
    );
}

#[test]
fn failed_canceled_and_rejected_are_failed() {
    for state in [
        "TASK_STATE_FAILED",
        "canceled",
        "TASK_STATE_CANCELED",
        "rejected",
    ] {
        let data = json!({"statusUpdate": {"status": {"state": state}}}).to_string();
        assert_eq!(
            classify_stream_disposition(&data),
            StreamDisposition::Failed,
            "state {state:?} should classify as Failed"
        );
    }
}

#[test]
fn jsonrpc_wrapped_result_is_classified_the_same_as_bare() {
    let bare = json!({"statusUpdate": {"status": {"state": "TASK_STATE_INPUT_REQUIRED"}}});
    let wrapped = json!({"result": bare});
    assert_eq!(
        classify_stream_disposition(&wrapped.to_string()),
        classify_stream_disposition(&bare.to_string()),
    );
    assert_eq!(
        classify_stream_disposition(&wrapped.to_string()),
        StreamDisposition::Paused
    );
}

#[test]
fn zero_three_dialect_final_flag_with_no_state_is_completed() {
    let data = json!({"result": {"kind": "status-update", "final": true}}).to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Completed
    );
}

#[test]
fn unparseable_payload_is_continue_not_a_panic() {
    assert_eq!(
        classify_stream_disposition("not json at all"),
        StreamDisposition::Continue
    );
}

#[test]
fn input_required_and_auth_required_constructors_round_trip_through_the_classifier() {
    let event = nasiko_types::a2a::input_required("task-1", "ctx-1", "which repo?");
    let wrapped = json!({"statusUpdate": event}).to_string();
    assert_eq!(
        classify_stream_disposition(&wrapped),
        StreamDisposition::Paused
    );

    let event = nasiko_types::a2a::auth_required("task-1", "ctx-1", "please authorize");
    let wrapped = json!({"statusUpdate": event}).to_string();
    assert_eq!(
        classify_stream_disposition(&wrapped),
        StreamDisposition::Paused
    );
}

// Confirmed live against `agent_proxy.rs`'s non-streaming branch (a real `SendMessage` call to
// github-hitl-agent): a full `Task` snapshot, no `statusUpdate` wrapper, `status.state` sitting
// directly under `result.task` instead. Before the `.task` fallback existed, this real shape
// classified as `Continue` — a genuine live pause silently passed through undetected.
#[test]
fn task_wrapped_non_streaming_snapshot_with_input_required_is_paused() {
    let data = json!({
        "result": {
            "task": {
                "id": "task-1",
                "status": {"state": "TASK_STATE_INPUT_REQUIRED"}
            }
        }
    })
    .to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Paused
    );
}

#[test]
fn task_wrapped_non_streaming_snapshot_with_completed_is_completed() {
    let data = json!({
        "result": {
            "task": {
                "id": "task-1",
                "status": {"state": "TASK_STATE_COMPLETED"}
            }
        }
    })
    .to_string();
    assert_eq!(
        classify_stream_disposition(&data),
        StreamDisposition::Completed
    );
}
