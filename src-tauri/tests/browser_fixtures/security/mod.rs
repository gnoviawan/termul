//! Host perimeter security fixtures.
//!
//! `ipc` runs on every OS under `cargo test --lib`: it sends real IPC
//! requests through Tauri's own ACL path, with the app's real capability
//! files, for every origin a tab can load.
//!
//! `engine` loads pages in real child webviews and is ignored by default
//! because it needs a display and a webview runtime. On Windows and Linux:
//!
//! ```text
//! cargo test --lib host_perimeter::security_fixtures::engine -- --ignored --test-threads=1
//! cargo test --lib --features custom-protocol host_perimeter::security_fixtures::engine -- --ignored --test-threads=1
//! ```
//!
//! The first run uses dev-build origin rules (the dev server origin is local
//! to Tauri), the second release rules (only the app protocol origin is
//! local; it needs `dist-tauri/` built). macOS needs the event loop on the
//! main thread, so it can only run `engine::run` from a `harness = false`
//! test target.

mod engine;
mod ipc;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Host-side runs of [`perimeter_probe`].
#[derive(Default)]
struct ProbeRuns(AtomicUsize);

impl ProbeRuns {
    fn count(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

#[tauri::command]
fn perimeter_probe(runs: tauri::State<'_, Arc<ProbeRuns>>) {
    runs.0.fetch_add(1, Ordering::SeqCst);
}
