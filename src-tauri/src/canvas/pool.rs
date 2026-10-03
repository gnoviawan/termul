//! `CanvasDaemonPool` — sole owner of the managed OpenPencil daemon lifecycle.
//!
//! Semantics mirror the OpenPencil VS Code `DaemonPool` exactly:
//! - one daemon per doc (keyed by canonical absolute path);
//! - concurrent acquires for the same doc coalesce onto one spawn (spawn
//!   failure clears the inflight slot so a later acquire can retry);
//! - a non-dispose exit respawns **once** (same doc + allow-origin), then
//!   evicts; respawn failure evicts;
//! - release (canvas close) evicts immediately — daemon lifetime = canvas
//!   lifetime, no keep-alive TTL; switching tabs never touches the pool;
//! - `shutdown_all()` disposes every daemon (stdin EOF → kill).
//!
//! Tauri-free: the desktop manages it in `lib.rs`, the standalone
//! `termul-server` constructs its own in `server_main.rs`. Never touches
//! `AppHandle`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::join_all;
use tokio::sync::watch;

use super::managed::{CanvasDaemon, DaemonSpawner, RealDaemonSpawner};
use super::{canvas_id_for_project, CanvasDaemonInfo, CanvasError, CanvasStatus, CODE_CANVAS_CLOSED};

/// A non-dispose daemon exit respawns at most once before eviction.
const MAX_RESPAWNS: u32 = 1;

/// Canonicalize a doc path into the pool's map key (verbatim-prefix-stripped
/// so spawned argv stays tool-friendly — same treatment as command paths).
/// When the file no longer resolves (deleted/renamed after the daemon
/// started), falls back to the verbatim-stripped input so close/save still
/// find and evict the entry instead of erroring and leaking the daemon.
/// Callers that must guarantee existence (web open, the desktop command)
/// validate the path BEFORE reaching the pool.
pub(crate) fn canonical_doc_key(doc_path: &str) -> String {
    let canonical = std::fs::canonicalize(doc_path).unwrap_or_else(|_| {
        // Deleted/renamed doc: keep the caller's path as the key.
        std::path::PathBuf::from(doc_path)
    });
    let text = canonical.to_string_lossy();
    crate::path_validation::strip_verbatim_prefix(&text).into_owned()
}

/// Outcome published to coalesced acquire waiters via a watch channel (the
/// channel retains the latest value, so no waiter can miss a completion).
#[derive(Clone)]
enum AcquireState {
    Pending,
    Ready(Arc<CanvasDaemon>),
    Failed(CanvasError),
}

struct Inflight {
    done: watch::Sender<AcquireState>,
    /// Set when the doc is released (or the pool shut down) while the spawn
    /// is running — the finalize path must then dispose the fresh daemon.
    cancelled: AtomicBool,
}

impl Inflight {
    fn new() -> (Arc<Self>, watch::Receiver<AcquireState>) {
        let (tx, rx) = watch::channel(AcquireState::Pending);
        (
            Arc::new(Self {
                done: tx,
                cancelled: AtomicBool::new(false),
            }),
            rx,
        )
    }
}

/// Per-doc supervision slot.
struct DocSlot {
    daemon: Option<Arc<CanvasDaemon>>,
    /// `--allow-origin` the daemon was spawned with (respawn reuses it).
    allow_origin: String,
    /// Crash counter for the respawn-once-then-evict policy. Never reset
    /// within an entry's lifetime (VS Code `DaemonPool` semantics: a
    /// non-dispose exit respawns AT MOST once per entry; the counter only
    /// starts over because eviction removes the slot and a later fresh
    /// acquire builds a brand-new entry).
    restarts: u32,
    /// Released / shut down — never respawn, and any inflight spawn result
    /// is an orphan to dispose.
    disposed: bool,
    /// Increments on every installed daemon; the exit watcher matches it so
    /// only the current daemon's exit drives a respawn.
    generation: u64,
    inflight: Option<Arc<Inflight>>,
    /// Web canvas session token (`ct`) for the browser-client embed surface:
    /// minted on the first web open of a live entry, REUSED on idempotent
    /// repeat opens (no iframe rebuild — see `canvas_token_for_doc`), and
    /// dropped with the slot on release/evict/shutdown so a stale `ct` stops
    /// authenticating. Survives respawns (the embed URL must stay valid
    /// across the crash policy). Never logged.
    canvas_token: Option<String>,
}

impl DocSlot {
    fn new(allow_origin: String) -> Self {
        Self {
            daemon: None,
            allow_origin,
            restarts: 0,
            disposed: false,
            generation: 0,
            inflight: None,
            canvas_token: None,
        }
    }
}

#[derive(Default)]
struct PoolState {
    docs: HashMap<String, DocSlot>,
    /// project_id → active doc key (per-project active tracking; one canvas
    /// per project).
    project_docs: HashMap<String, String>,
    /// doc key → owning project (reverse map for cleanup).
    doc_projects: HashMap<String, String>,
    /// Most recently acquired doc (the desktop agentation MCP proxy routes
    /// here — the desktop has one active project at a time).
    last_active_doc: Option<String>,
    shut_down: bool,
}

impl PoolState {
    fn clear_active(&mut self, doc_key: &str) {
        self.project_docs.retain(|_, doc| doc != doc_key);
        self.doc_projects.remove(doc_key);
        if self.last_active_doc.as_deref() == Some(doc_key) {
            self.last_active_doc = None;
        }
    }
}

struct PoolInner {
    spawner: Arc<dyn DaemonSpawner>,
    state: parking_lot::Mutex<PoolState>,
}

impl PoolInner {
    /// Perform a spawn for `doc_key` and finalize it into the pool: install
    /// the daemon + wire its exit watcher, or publish the failure. Runs as a
    /// detached task (acquire waiters observe the result through the inflight
    /// watch channel), so a dropped acquire future never cancels a spawn
    /// halfway.
    async fn perform_spawn(
        self: &Arc<Self>,
        doc_key: &str,
        project_id: Option<&str>,
        allow_origin: &str,
        inflight: Arc<Inflight>,
    ) {
        let spawned = self.spawner.spawn(doc_key, allow_origin).await;
        match spawned {
            Err(err) => {
                log::warn!("[canvas] daemon spawn failed doc={doc_key} code={}", err.code);
                self.finish_inflight(doc_key, &inflight, AcquireState::Failed(err));
            }
            Ok(daemon) => {
                let mut orphaned = false;
                let mut generation = 0u64;
                {
                    let mut guard = self.state.lock();
                    if guard.shut_down || inflight.cancelled.load(Ordering::SeqCst) {
                        orphaned = true;
                    } else if let Some(slot) = guard.docs.get_mut(doc_key) {
                        if slot.disposed
                            || slot
                                .inflight
                                .as_ref()
                                .is_none_or(|current| !Arc::ptr_eq(current, &inflight))
                        {
                            // Released (or superseded) while spawning — the
                            // freshly spawned daemon has no owner.
                            orphaned = true;
                        } else {
                            slot.daemon = Some(daemon.clone());
                            slot.generation += 1;
                            generation = slot.generation;
                            slot.inflight = None;
                            if let Some(project) = project_id {
                                guard
                                    .project_docs
                                    .insert(project.to_string(), doc_key.to_string());
                                guard
                                    .doc_projects
                                    .insert(doc_key.to_string(), project.to_string());
                            }
                            guard.last_active_doc = Some(doc_key.to_string());
                        }
                    } else {
                        orphaned = true;
                    }
                    if orphaned {
                        // Remove the slot ONLY when it still carries OUR
                        // inflight: a reopen-while-spawning may have
                        // replaced the disposed slot with a fresh slot +
                        // inflight that must survive this finalize.
                        let slot_is_ours = guard.docs.get(doc_key).is_some_and(|slot| {
                            slot.inflight
                                .as_ref()
                                .is_some_and(|current| Arc::ptr_eq(current, &inflight))
                        });
                        if slot_is_ours {
                            guard.docs.remove(doc_key);
                        }
                    }
                }
                if orphaned {
                    log::warn!(
                        "[canvas] daemon spawn raced release/shutdown doc={doc_key} — disposing"
                    );
                    daemon.dispose().await;
                    self.finish_inflight(
                        doc_key,
                        &inflight,
                        AcquireState::Failed(CanvasError::new(
                            CODE_CANVAS_CLOSED,
                            "canvas closed while the daemon was starting",
                        )),
                    );
                    return;
                }
                log::info!("[canvas] daemon acquired doc={doc_key} port={}", daemon.port);
                let _ = inflight.done.send(AcquireState::Ready(daemon.clone()));
                self.wire_exit_watcher(doc_key.to_string(), generation, daemon);
            }
        }
    }

    /// Publish an inflight outcome and clear the slot so a later acquire
    /// retries instead of joining a dead future.
    fn finish_inflight(&self, doc_key: &str, inflight: &Arc<Inflight>, state: AcquireState) {
        {
            let mut guard = self.state.lock();
            if let Some(slot) = guard.docs.get_mut(doc_key) {
                if slot
                    .inflight
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, inflight))
                {
                    slot.inflight = None;
                }
            }
        }
        let _ = inflight.done.send(state);
    }

    /// Spawn the pool-owned exit watcher: wait for the daemon's exit, then —
    /// unless the exit was a pool-initiated dispose — drive the
    /// respawn-once-then-evict policy.
    fn wire_exit_watcher(self: &Arc<Self>, doc_key: String, generation: u64, daemon: Arc<CanvasDaemon>) {
        let inner = Arc::clone(self);
        let mut exit_rx = daemon.exit_rx();
        tokio::spawn(async move {
            if exit_rx.borrow().is_some() {
                return;
            }
            while exit_rx.changed().await.is_ok() {
                if exit_rx.borrow().is_some() {
                    break;
                }
            }
            // A dispose-driven exit is expected; anything else is a crash.
            if daemon.is_disposed() {
                return;
            }
            inner.handle_exit(&doc_key, generation).await;
        });
    }

    /// Crash policy: respawn once with the same doc + allow-origin, then
    /// evict. A concurrent acquire inflight already replaces the daemon —
    /// skip the respawn spawn (the crash still counts).
    async fn handle_exit(self: &Arc<Self>, doc_key: &str, generation: u64) {
        let respawn = {
            let mut guard = self.state.lock();
            if guard.shut_down {
                return;
            }
            let Some(slot) = guard.docs.get_mut(doc_key) else {
                return;
            };
            if slot.disposed || slot.generation != generation {
                // Stale watcher (an eviction/replacement already happened).
                return;
            }
            slot.daemon = None;
            if slot.restarts >= MAX_RESPAWNS {
                guard.docs.remove(doc_key);
                guard.clear_active(doc_key);
                log::warn!("[canvas] daemon crashed again doc={doc_key} — evicting");
                return;
            }
            slot.restarts += 1;
            if slot.inflight.is_some() {
                // An acquire is already spawning; its daemon becomes the
                // replacement.
                log::warn!(
                    "[canvas] daemon exited unexpectedly doc={doc_key} — acquire already respawning"
                );
                return;
            }
            let allow_origin = slot.allow_origin.clone();
            let (inflight, _rx) = Inflight::new();
            slot.inflight = Some(Arc::clone(&inflight));
            Some((allow_origin, inflight))
        };
        if let Some((allow_origin, inflight)) = respawn {
            log::warn!("[canvas] daemon exited unexpectedly doc={doc_key} — respawning once");
            self.perform_spawn(doc_key, None, &allow_origin, inflight)
                .await;
        }
    }
}

/// The canvas daemon pool. Clone-safe handle (all state behind one `Arc`).
#[derive(Clone)]
pub struct CanvasDaemonPool {
    inner: Arc<PoolInner>,
}

impl CanvasDaemonPool {
    /// Production pool backed by the real `op-host-web-server` spawner.
    pub fn real() -> Self {
        Self::new(Arc::new(RealDaemonSpawner))
    }

    /// Test/injected pool.
    pub fn new(spawner: Arc<dyn DaemonSpawner>) -> Self {
        Self {
            inner: Arc::new(PoolInner {
                spawner,
                state: parking_lot::Mutex::new(PoolState::default()),
            }),
        }
    }

    /// Acquire (or spawn) the daemon for a doc. Concurrent acquires for the
    /// same doc coalesce onto one spawn; spawn failure clears the inflight
    /// slot for retry. Also records the project's active doc.
    pub async fn acquire(
        &self,
        doc_path: &str,
        allow_origin: &str,
        project_id: &str,
    ) -> Result<Arc<CanvasDaemon>, CanvasError> {
        let doc_key = canonical_doc_key(doc_path);
        let inner = &self.inner;
        // The ready path returns directly from the critical section below,
        // so the step enum only covers the two spawn paths.
        enum Step {
            Wait(watch::Receiver<AcquireState>),
            Launch {
                inflight: Arc<Inflight>,
                rx: watch::Receiver<AcquireState>,
                allow_origin: String,
            },
        }
        let step = {
            let mut guard = inner.state.lock();
            if guard.shut_down {
                return Err(CanvasError::new(
                    CODE_CANVAS_CLOSED,
                    "canvas pool is shut down",
                ));
            }
            // A disposed slot is stale: release keeps it ONLY so its
            // inflight spawn's finalize can dispose the orphaned child —
            // joining that cancelled inflight would fail the reopen with
            // CANVAS_CLOSED. Replace ANY disposed slot (the old spawn task
            // resolves its own orphan path without a slot: the finalize
            // removes only a slot that still owns its inflight).
            if guard.docs.get(&doc_key).is_some_and(|slot| slot.disposed) {
                guard.docs.remove(&doc_key);
            }
            let slot = guard
                .docs
                .entry(doc_key.clone())
                .or_insert_with(|| DocSlot::new(allow_origin.to_string()));
            if let Some(daemon) = slot.daemon.clone() {
                guard
                    .project_docs
                    .insert(project_id.to_string(), doc_key.clone());
                guard
                    .doc_projects
                    .insert(doc_key.clone(), project_id.to_string());
                guard.last_active_doc = Some(doc_key.clone());
                return Ok(daemon);
            }
            if let Some(inflight) = slot.inflight.as_ref() {
                Step::Wait(inflight.done.subscribe())
            } else {
                let (inflight, rx) = Inflight::new();
                slot.inflight = Some(Arc::clone(&inflight));
                slot.allow_origin = allow_origin.to_string();
                Step::Launch {
                    inflight,
                    rx,
                    allow_origin: allow_origin.to_string(),
                }
            }
        };
        match step {
            Step::Wait(mut rx) => wait_for_acquire(&mut rx).await,
            Step::Launch {
                inflight,
                mut rx,
                allow_origin,
            } => {
                let inner_arc = Arc::clone(inner);
                let doc_key_owned = doc_key.clone();
                let project_owned = project_id.to_string();
                // Detached: the spawn result lands in the pool regardless of
                // whether the initiating acquire future is dropped.
                tokio::spawn(async move {
                    inner_arc
                        .perform_spawn(
                            &doc_key_owned,
                            Some(&project_owned),
                            &allow_origin,
                            inflight,
                        )
                        .await;
                });
                wait_for_acquire(&mut rx).await
            }
        }
    }

    /// Release the daemon for a doc (canvas tab close): immediate evict —
    /// dispose (stdin EOF → kill), clear active tracking. If a spawn is
    /// still inflight, the finalize path disposes the fresh daemon instead.
    pub async fn release(&self, doc_path: &str) {
        let doc_key = canonical_doc_key(doc_path);
        let daemon = {
            let mut guard = self.inner.state.lock();
            guard.clear_active(&doc_key);
            let Some(slot) = guard.docs.get_mut(&doc_key) else {
                return;
            };
            slot.disposed = true;
            let has_inflight = slot.inflight.is_some();
            if let Some(inflight) = &slot.inflight {
                inflight.cancelled.store(true, Ordering::SeqCst);
            }
            let daemon = slot.daemon.take();
            if !has_inflight {
                guard.docs.remove(&doc_key);
            }
            daemon
        };
        if let Some(daemon) = daemon {
            log::info!("[canvas] releasing daemon doc={doc_key} (stdin EOF)");
            daemon.dispose().await;
            log::info!("[canvas] daemon released doc={doc_key}");
        }
    }

    /// Dispose every daemon and reject further acquires (app exit / server
    /// shutdown). Inflight spawns resolve as orphans on completion.
    pub async fn shutdown_all(&self) {
        let daemons = {
            let mut guard = self.inner.state.lock();
            guard.shut_down = true;
            let mut daemons = Vec::new();
            for slot in guard.docs.values_mut() {
                slot.disposed = true;
                if let Some(inflight) = &slot.inflight {
                    inflight.cancelled.store(true, Ordering::SeqCst);
                }
                if let Some(daemon) = slot.daemon.take() {
                    daemons.push(daemon);
                }
            }
            guard.docs.clear();
            guard.project_docs.clear();
            guard.doc_projects.clear();
            guard.last_active_doc = None;
            daemons
        };
        if daemons.is_empty() {
            return;
        }
        log::info!("[canvas] shutting down {} daemon(s)", daemons.len());
        join_all(daemons.iter().map(|daemon| daemon.dispose())).await;
        log::info!("[canvas] all daemons shut down");
    }

    /// Live daemon for a doc path (canonicalized lookup).
    pub fn daemon_for_doc(&self, doc_path: &str) -> Option<Arc<CanvasDaemon>> {
        let doc_key = canonical_doc_key(doc_path);
        let guard = self.inner.state.lock();
        guard.docs.get(&doc_key).and_then(|slot| slot.daemon.clone())
    }

    /// The most recently acquired daemon (the desktop agentation
    /// `/canvas/mcp` mount routes here).
    pub fn active_daemon(&self) -> Option<Arc<CanvasDaemon>> {
        let guard = self.inner.state.lock();
        let doc_key = guard.last_active_doc.clone()?;
        guard.docs.get(&doc_key).and_then(|slot| slot.daemon.clone())
    }

    /// The project's active canvas daemon.
    pub fn active_daemon_for_project(&self, project_id: &str) -> Option<Arc<CanvasDaemon>> {
        let guard = self.inner.state.lock();
        let doc_key = guard.project_docs.get(project_id)?;
        guard.docs.get(doc_key).and_then(|slot| slot.daemon.clone())
    }

    /// The daemon a `/canvas/<id>/*` proxy path routes to (id derived from
    /// the project via [`canvas_id_for_project`]).
    pub fn daemon_for_canvas_id(&self, canvas_id: &str) -> Option<Arc<CanvasDaemon>> {
        let guard = self.inner.state.lock();
        for (project, doc_key) in guard.project_docs.iter() {
            if canvas_id_for_project(project) == canvas_id {
                return guard.docs.get(doc_key).and_then(|slot| slot.daemon.clone());
            }
        }
        None
    }

    /// Store the web canvas session token on the doc's entry (overwrites any
    /// previous token). Returns `false` when the entry is already gone
    /// (released/evicted between acquire and set) — the caller must then
    /// release the freshly spawned daemon instead of using it.
    pub fn set_canvas_token(&self, doc_key: &str, token: String) -> bool {
        let mut guard = self.inner.state.lock();
        guard.docs.get_mut(doc_key).is_some_and(|slot| {
            slot.canvas_token = Some(token);
            true
        })
    }

    /// The doc entry's current canvas session token, when one is set — used
    /// by web open for idempotent repeat opens (same embed URL + token, no
    /// iframe rebuild). Rotation happens only when `None` (fresh entry).
    pub fn canvas_token_for_doc(&self, doc_key: &str) -> Option<String> {
        let guard = self.inner.state.lock();
        guard
            .docs
            .get(doc_key)
            .and_then(|slot| slot.canvas_token.clone())
    }

    /// Constant-time acceptance check of a presented `ct` query-param token
    /// for the canvas id (resolves id → project → active doc entry). Missing
    /// entry, missing token, or length mismatch never matches — mirrors
    /// `WebAuth::accepts` semantics. The token itself is never surfaced.
    pub fn verify_canvas_token(&self, canvas_id: &str, presented: &str) -> bool {
        use subtle::ConstantTimeEq;
        if presented.is_empty() {
            return false;
        }
        let guard = self.inner.state.lock();
        let Some(doc_key) = guard
            .project_docs
            .iter()
            .find(|(project, _)| canvas_id_for_project(project) == canvas_id)
            .map(|(_, doc_key)| doc_key.clone())
        else {
            return false;
        };
        let Some(slot) = guard.docs.get(&doc_key) else {
            return false;
        };
        let Some(token) = slot.canvas_token.as_deref() else {
            return false;
        };
        token.as_bytes().ct_eq(presented.as_bytes()).into()
    }

    /// Constant-time acceptance check of a presented token against the
    /// ACTIVE (last-opened) doc's canvas session token — the credential for
    /// the root canvas routes (`/pkg|/canvaskit|/api`, the editor's
    /// absolute-path traffic) and the `/canvas/mcp` cookie path. Missing
    /// active doc, missing token, or empty presented value never matches.
    pub fn verify_active_canvas_token(&self, presented: &str) -> bool {
        use subtle::ConstantTimeEq;
        if presented.is_empty() {
            return false;
        }
        let guard = self.inner.state.lock();
        let Some(doc_key) = guard.last_active_doc.as_deref() else {
            return false;
        };
        let Some(slot) = guard.docs.get(doc_key) else {
            return false;
        };
        let Some(token) = slot.canvas_token.as_deref() else {
            return false;
        };
        token.as_bytes().ct_eq(presented.as_bytes()).into()
    }

    /// Snapshot for `canvas_status`.
    pub fn status(&self) -> CanvasStatus {
        let guard = self.inner.state.lock();
        CanvasStatus {
            daemons: guard
                .docs
                .values()
                .filter_map(|slot| {
                    slot.daemon.as_ref().map(|daemon| CanvasDaemonInfo {
                        doc_key: daemon.doc_key.clone(),
                        port: daemon.port,
                        version: daemon.version.clone(),
                    })
                })
                .collect(),
            active_doc_key: guard.last_active_doc.clone(),
        }
    }
}

/// Resolve a coalesced acquire through the inflight watch channel.
async fn wait_for_acquire(
    rx: &mut watch::Receiver<AcquireState>,
) -> Result<Arc<CanvasDaemon>, CanvasError> {
    match rx
        .wait_for(|state| !matches!(state, AcquireState::Pending))
        .await
    {
        Ok(state) => match &*state {
            AcquireState::Ready(daemon) => Ok(Arc::clone(daemon)),
            AcquireState::Failed(err) => Err(err.clone()),
            AcquireState::Pending => Err(CanvasError::new(
                CODE_CANVAS_CLOSED,
                "canvas acquire watcher resolved to Pending",
            )),
        },
        Err(err) => Err(CanvasError::new(
            CODE_CANVAS_CLOSED,
            format!("canvas acquire watcher closed: {err}"),
        )),
    }
}
