pub mod authz;
pub mod dispatcher;
pub mod notifier;
pub mod repo;
pub mod store;
pub mod types;

// This crate's two independently-built HITL implementations (merged from separate PRs) used to
// each carry their own `HitlError`, `authorize_hitl_action`, `HitlRequestRow`, and
// `list_pending_for` — consolidated onto `store.rs`'s versions (the ones already in production
// use via `HitlStore`/this crate root) since `repo.rs`'s copies had no callers outside its own
// tests. `repo.rs` now uses `store::{HitlError, HitlRequestRow}` directly.
pub use authz::{HitlAction, HitlAuthzError, HitlIdentity, authorize_hitl_action};
pub use dispatcher::{DispatcherConfig, NotifyError, ResumeNotifier};
pub use notifier::RuntimeResumeNotifier;
pub use repo::{NewAuthRequired, NewSessionGrant, NewToolApproval, ResolveDecision};
pub use store::{
    FailureKind, HitlError, HitlStore, PgHitlStore, ResolveOutcome, resolve_display_row,
};
pub use types::{
    HitlKind, HitlOrigin, HitlRequest, HitlStatus, NewHitlRequest, ParseEnumError, ResumeStatus,
};
