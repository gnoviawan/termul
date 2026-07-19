//! Dev static serving for `termul-server` (Story 1.3).
//!
//! Debug/dev serves the Vite web build from repo-root `dist-web/` via
//! `tower_http::services::ServeDir` (path resolved from `CARGO_MANIFEST_DIR`,
//! not process CWD). Production `Assets::get` embedding/serving is Story 1.11.

use std::path::{Path, PathBuf};

use tower_http::services::{ServeDir, ServeFile};

/// Repo-root `dist-web/` directory (sibling of `src-tauri/`).
///
/// Resolved via `CARGO_MANIFEST_DIR` so serving works regardless of process CWD.
pub fn dist_web_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-web")
}

/// Whether `dist-web/index.html` exists on disk (for startup diagnostics).
pub fn dist_web_ready() -> bool {
    dist_web_dir().join("index.html").is_file()
}

/// ServeDir + SPA `index.html` fallback for the hash-router client.
pub fn static_service() -> ServeDir<ServeFile> {
    static_service_from(&dist_web_dir())
}

/// Same as [`static_service`], but with an injectable root (unit tests).
pub fn static_service_from(dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))
}

/// Scaffold for Story 1.11 production embedding — not wired into the live router.
///
/// `allow_missing` keeps `cargo build --features standalone-server` green when
/// `dist-web/` is absent (CI `standalone-server-build` does not run `build:web`).
/// Story 1.11 owns strict embed-time failure for release serving.
#[cfg(feature = "standalone-server")]
#[derive(rust_embed::Embed)]
#[folder = "../dist-web/"]
#[allow_missing = true]
#[allow(dead_code)] // wired in Story 1.11
pub struct Assets;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dist_web_dir_points_at_repo_root_sibling() {
        let dir = dist_web_dir();
        let name = dir.file_name().and_then(|n| n.to_str());
        assert_eq!(name, Some("dist-web"));
        // Parent of dist-web should be the repo root (sibling of src-tauri).
        let parent = dir.parent().expect("parent");
        assert!(
            parent.join("src-tauri").is_dir(),
            "expected src-tauri next to dist-web, got parent {:?}",
            parent
        );
    }
}
