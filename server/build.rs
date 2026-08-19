//! Resolves the UI asset root and exports it as `NASIKO_UI` for `rust_embed`.
//!
//! The UI lives in a single top-level `ui/` tree shared by both editions, but
//! this crate sits at a different depth in the private repo than in the public
//! one: `oss/server/` here, `server/` after `scripts/sync-oss.sh` strips the
//! `oss/` prefix. A literal `#[folder = "../../ui/oss/"]` is therefore correct
//! in exactly one of the two layouts — it silently broke the public repo when
//! the UI was consolidated under `ui/` (previously `oss/ui/`, which stripped to
//! `ui/` and resolved at both depths).
//!
//! rust-embed hard-errors at compile time on a missing `folder`, so the public
//! build failed rather than shipping an empty binary. Resolving the root here
//! and interpolating it (`#[folder = "$NASIKO_UI/oss/"]`, which needs
//! rust-embed's `interpolate-folder-path` feature) makes both layouts work off
//! one source of truth, and keeps working if the crate ever moves again.

use std::path::{Path, PathBuf};

/// Marker that identifies the real UI root: `ui/common/` is the shared design
/// system, present in every layout and in both editions.
const MARKER: &str = "common";

fn find_ui_root(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors() {
        let candidate = dir.join("ui");
        if candidate.join(MARKER).is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is always set by cargo"),
    );

    let ui_root = find_ui_root(&manifest_dir).unwrap_or_else(|| {
        panic!(
            "could not locate the UI root: walked up from {} looking for a `ui/{}/` directory. \
             The server embeds ui/oss/ and ui/common/ at compile time, so the tree must be \
             present. If this is the public repo, scripts/sync-oss.sh did not publish ui/.",
            manifest_dir.display(),
            MARKER,
        )
    });

    // Absolute, so it does not inherit this crate's depth.
    println!("cargo:rustc-env=NASIKO_UI={}", ui_root.display());

    // rust-embed reads the tree at compile time in release builds, so changes to
    // the assets must invalidate this crate.
    println!("cargo:rerun-if-changed={}", ui_root.join("oss").display());
    println!("cargo:rerun-if-changed={}", ui_root.join(MARKER).display());
    println!("cargo:rerun-if-changed=build.rs");
}
