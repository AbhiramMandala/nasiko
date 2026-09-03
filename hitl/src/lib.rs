pub mod authz;
pub mod dispatcher;
pub mod error;
pub mod notifier;
pub mod repo;
pub mod store;
pub mod types;

// `authz::authorize_hitl_action` (action-based: View/Resolve/Cancel) wins the crate-root export
// over `repo::authorize_hitl_action` (a simpler owner-only bool check) — both exist because the
// two HITL implementations that merged into this crate each built their own; `repo`'s copy is
// still reachable via its qualified path, used internally by `repo.rs` itself and nowhere else.
// Likewise `store::HitlError` (the `HitlStore` trait's error type) wins over `error::HitlError`
// (used internally by `repo.rs`, reachable via `nasiko_hitl::error::HitlError` if ever needed
// externally) — no external caller depended on either bare re-export before this merge.
pub use authz::{HitlAction, HitlAuthzError, HitlIdentity, authorize_hitl_action};
pub use dispatcher::{DispatcherConfig, NotifyError, ResumeNotifier};
pub use notifier::RuntimeResumeNotifier;
pub use repo::{NewAuthRequired, NewSessionGrant, NewToolApproval, ResolveDecision};
pub use store::{HitlError, HitlStore, PgHitlStore, ResolveOutcome, resolve_display_row};
pub use types::{
    HitlKind, HitlOrigin, HitlRequest, HitlStatus, NewHitlRequest, ParseEnumError, ResumeStatus,
};
