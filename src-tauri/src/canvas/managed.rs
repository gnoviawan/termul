//! Managed `op-host-web-server` sidecar: binary resolution, argv, spawn +
//! handshake, and the stdin-EOF dispose contract.
//!
//! The spawn pattern mirrors `remote::cloudflared` (piped stdio,
//! `kill_on_drop`, Windows `CREATE_NO_WINDOW`, first-line stdout handshake
//! under a timeout, keep-draining-to-EOF) and the supervision shape of
//! `remote::host` (a task owns `child.wait()`).
//!
//! Handshake codec + argv builder are pure functions; the spawn seam is the
//! [`DaemonSpawner`] trait so the pool (and its tests) never depend on the
//! sibling OpenPencil checkout.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{
    CanvasError, CODE_BINARY_NOT_FOUND, CODE_HANDSHAKE_INVALID, CODE_HANDSHAKE_TIMEOUT,
    CODE_SPAWN_FAILED,
};

/// Spawn → handshake deadline (mirrors the OpenPencil VS Code client).
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// stdin-EOF grace before a hard kill on dispose (OpenPencil client uses 3s).
const DISPOSE_SIGKILL_AFTER: Duration = Duration::from_secs(3);
/// Safety bound for `dispose()` awaiting the watchdog's kill fallback.
const DISPOSE_WAIT_BOUND: Duration = Duration::from_secs(6);
/// Cap for forwarded daemon log lines (never logs the token — redacted first).
const DRAIN_LINE_CAP: usize = 512;

// ---------------------------------------------------------------------------
// Handshake codec (pure)
// ---------------------------------------------------------------------------

/// Validated daemon handshake: the port the daemon actually bound, the
/// lifecycle token (never logged, never sent to remote clients), and the
/// daemon's version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonHandshake {
    pub port: u16,
    pub token: String,
    pub version: String,
}

/// Wire shape of the first stdout line, mirrored from OpenPencil
/// `serve_options::handshake_json`. `port` parses as `u64` so negative /
/// non-integer / out-of-range values all fail validation the same way the
/// TypeScript client's checks do.
#[derive(Debug, Deserialize)]
struct HandshakeWire {
    ok: bool,
    port: u64,
    token: String,
    version: String,
}

/// Parse + validate the first stdout handshake line. Pure — unit-testable
/// without spawning anything. Mirrors `daemon-client.ts#parseHandshake`:
/// JSON object, `ok === true`, integer port in `0..=65535`, non-empty token,
/// string version.
pub(crate) fn parse_handshake_line(line: &str) -> Result<DaemonHandshake, CanvasError> {
    let invalid = |message: &str| CanvasError::new(CODE_HANDSHAKE_INVALID, message);
    let wire: HandshakeWire = serde_json::from_str(line.trim())
        .map_err(|_| invalid("handshake is not valid JSON"))?;
    if !wire.ok {
        return Err(invalid("handshake missing \"ok\":true"));
    }
    // Port 0 is meaningless post-bind (the daemon reports the port it
    // actually bound) and anything above 65535 is not a port.
    if wire.port == 0 || wire.port > u64::from(u16::MAX) {
        return Err(invalid("handshake port invalid"));
    }
    if wire.token.is_empty() {
        return Err(invalid("handshake token invalid"));
    }
    Ok(DaemonHandshake {
        port: wire.port as u16,
        token: wire.token,
        version: wire.version,
    })
}

// ---------------------------------------------------------------------------
// argv builder (pure)
// ---------------------------------------------------------------------------

/// Managed-mode argv tail (after the binary): exactly the grammar OpenPencil
/// `parse_serve_web_args_managed` accepts. `--port 0` requests an
/// OS-assigned port (learned from the handshake); `--allow-origin` is an
/// exact string (never `*`).
pub(crate) fn build_managed_argv(doc_path: &str, allow_origin: &str) -> Vec<String> {
    vec![
        "--serve-web".to_string(),
        "--managed".to_string(),
        "--port".to_string(),
        "0".to_string(),
        "--file".to_string(),
        doc_path.to_string(),
        "--allow-origin".to_string(),
        allow_origin.to_string(),
    ]
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn daemon_binary_name() -> &'static str {
    "op-host-web-server.exe"
}
#[cfg(not(target_os = "windows"))]
fn daemon_binary_name() -> &'static str {
    "op-host-web-server"
}

/// A resolved daemon binary. `bundle_root` is `Some` when the binary was
/// derived from an OpenPencil checkout root — the caller then auto-sets
/// `OPENPENCIL_WEB_BUNDLE_DIR` / `OPENPENCIL_CANVASKIT_DIR` for the child
/// (the daemon does NOT embed the wasm bundle).
#[derive(Debug, Clone)]
pub struct ResolvedDaemon {
    pub binary: PathBuf,
    pub bundle_root: Option<PathBuf>,
}

/// Parameterized resolution core (pure w.r.t. its inputs, so tests never
/// touch process env):
///
/// 1. `env_binary` (`TERMUL_OP_HOST_SERVER`) — direct binary path, no
///    bundle-dir inference;
/// 2. `env_root` (`TERMUL_OPENPENCIL_ROOT`) — checkout root;
/// 3. each `base` directory's ancestors, looking for
///    `<ancestor>/../../openpencil` (the sibling-checkout dev layout: from
///    the termul repo root, `../../openpencil`).
///
/// Under a checkout root the binary resolves from
/// `target/{release,debug}/op-host-web-server[.exe]` (release preferred).
pub(crate) fn resolve_daemon_binary_from(
    env_binary: Option<&str>,
    env_root: Option<&str>,
    bases: &[PathBuf],
) -> Result<ResolvedDaemon, CanvasError> {
    if let Some(raw) = env_binary.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(ResolvedDaemon {
                binary: path,
                bundle_root: None,
            });
        }
        return Err(CanvasError::new(
            CODE_BINARY_NOT_FOUND,
            format!(
                "op-host-web-server binary not found at {} (TERMUL_OP_HOST_SERVER)",
                path.display()
            ),
        ));
    }

    let root = env_root
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| find_sibling_checkout(bases));
    let Some(root) = root else {
        return Err(CanvasError::new(
            CODE_BINARY_NOT_FOUND,
            "op-host-web-server binary not found: set TERMUL_OP_HOST_SERVER or \
             TERMUL_OPENPENCIL_ROOT, or build the sibling openpencil checkout \
             (cargo build -p op-host-web-server)",
        ));
    };

    for profile in ["release", "debug"] {
        let candidate = root.join("target").join(profile).join(daemon_binary_name());
        if candidate.is_file() {
            return Ok(ResolvedDaemon {
                binary: candidate,
                bundle_root: Some(root),
            });
        }
    }
    Err(CanvasError::new(
        CODE_BINARY_NOT_FOUND,
        format!(
            "op-host-web-server binary not found under {} (looked in target/release \
             and target/debug)",
            root.display()
        ),
    ))
}

/// Walk the ancestors of each base looking for the sibling openpencil
/// checkout (`<ancestor>/../../openpencil`, normalized — no lexical `..`
/// components in the returned path). Bounded to 8 hops per base so a bogus
/// cwd cannot spin.
fn find_sibling_checkout(bases: &[PathBuf]) -> Option<PathBuf> {
    for base in bases {
        let mut current = Some(base.as_path());
        let mut hops = 0;
        while let Some(dir) = current {
            if hops > 8 {
                break;
            }
            if let Some(candidate) = sibling_checkout_at(dir) {
                return Some(candidate);
            }
            current = dir.parent();
            hops += 1;
        }
    }
    None
}

/// `<dir>/../../openpencil` when that directory exists.
fn sibling_checkout_at(dir: &Path) -> Option<PathBuf> {
    let up = dir.parent()?.parent()?;
    let candidate = up.join("openpencil");
    candidate.is_dir().then_some(candidate)
}

static BINARY_CACHE: OnceLock<ResolvedDaemon> = OnceLock::new();

/// Production resolution (env + cwd/exe-ancestor checkout discovery).
/// Successes are cached (`OnceLock`); failures re-resolve so a sibling build
/// appearing later is picked up without a restart.
pub fn resolve_daemon_binary() -> Result<ResolvedDaemon, CanvasError> {
    if let Some(cached) = BINARY_CACHE.get() {
        return Ok(cached.clone());
    }
    let mut bases = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            bases.push(exe_dir.to_path_buf());
        }
    }
    let env_binary = std::env::var("TERMUL_OP_HOST_SERVER").ok();
    let env_root = std::env::var("TERMUL_OPENPENCIL_ROOT").ok();
    let resolved = resolve_daemon_binary_from(env_binary.as_deref(), env_root.as_deref(), &bases)?;
    let _ = BINARY_CACHE.set(resolved.clone());
    Ok(resolved)
}

/// Auto-set the bundle env vars when the binary came from a checkout root
/// (never overriding values the operator already exported).
fn apply_bundle_env(command: &mut Command, root: &Path) {
    if std::env::var_os("OPENPENCIL_WEB_BUNDLE_DIR").is_none() {
        command.env(
            "OPENPENCIL_WEB_BUNDLE_DIR",
            root.join("crates/op-host-web/pkg"),
        );
    }
    if std::env::var_os("OPENPENCIL_CANVASKIT_DIR").is_none() {
        command.env(
            "OPENPENCIL_CANVASKIT_DIR",
            root.join("crates/op-host-web/assets/canvaskit"),
        );
    }
}

// ---------------------------------------------------------------------------
// Daemon handle + supervision
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn configure_background_command(command: &mut Command) {
    // CREATE_NO_WINDOW (0x08000000) — same flag as the rg/cloudflared
    // sidecars so spawning the daemon never flashes a console window.
    command.creation_flags(0x0800_0000);
}
#[cfg(not(target_os = "windows"))]
fn configure_background_command(_command: &mut Command) {}

/// Shared control core of one managed daemon. The `Child` itself is owned
/// exclusively by the supervision task ([`supervise_daemon_exit`]) — the
/// pool never touches it, which keeps `alive()`/`dispose()` race-free.
pub(crate) struct DaemonCore {
    /// Held so closing it (drop) delivers the stdin-EOF shutdown lease.
    stdin: parking_lot::Mutex<Option<ChildStdin>>,
    /// Signals the supervisor that a pool-initiated dispose started (stdin
    /// was closed; enforce the 3s kill grace).
    dispose: CancellationToken,
    /// `None` while running; `Some(exit_code)` once the child exited.
    exited: watch::Sender<Option<i32>>,
    /// Set by the pool before dispose so the exit watcher can distinguish an
    /// expected (dispose-driven) exit from a crash.
    disposed: AtomicBool,
}

/// A live managed `op-host-web-server`. Cloning the `Arc` shares the daemon;
/// `dispose()` is the only shutdown path (stdin EOF → 3s grace → kill).
pub struct CanvasDaemon {
    /// Canonicalized doc path — the pool's map key.
    pub doc_key: String,
    /// The `--allow-origin` value this daemon was spawned with (respawn
    /// reuses it verbatim).
    pub allow_origin: String,
    /// Loopback port the daemon bound (from the handshake).
    pub port: u16,
    /// Lifecycle token (never logged, never sent to remote clients). Retained
    /// per the managed contract for compatibility; request authority is the
    /// local supervisor lease + origin gate, so nothing reads it yet.
    #[allow(dead_code)]
    pub(crate) token: String,
    /// Daemon version from the handshake.
    pub version: String,
    pub(crate) core: Arc<DaemonCore>,
}

impl std::fmt::Debug for CanvasDaemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately excludes the lifecycle token (never logged).
        f.debug_struct("CanvasDaemon")
            .field("doc_key", &self.doc_key)
            .field("port", &self.port)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl CanvasDaemon {
    /// `true` until the supervision task observed the child exit.
    pub fn alive(&self) -> bool {
        self.core.exited.borrow().is_none()
    }

    /// The daemon's managed (handshake) token. Never logged. On the desktop
    /// this doubles as the canvas MCP bearer credential (the `canvas_open`
    /// result exposes it so the renderer/agents can authenticate against
    /// the agentation `/canvas/mcp` mounts).
    pub(crate) fn managed_token(&self) -> &str {
        &self.token
    }

    /// Constant-time acceptance check of a presented bearer token against
    /// this daemon's managed (handshake) token (mirrors `WebAuth::accepts`
    /// semantics: a missing/empty presented token never matches).
    pub(crate) fn accepts_managed_token(&self, presented: &str) -> bool {
        use subtle::ConstantTimeEq;
        !presented.is_empty() && self.token.as_bytes().ct_eq(presented.as_bytes()).into()
    }
    /// `true` once the pool initiated a dispose (expected exit).
    pub(crate) fn is_disposed(&self) -> bool {
        self.core.disposed.load(Ordering::SeqCst)
    }

    /// Receiver that yields `Some(exit_code)` when the daemon exits.
    pub(crate) fn exit_rx(&self) -> watch::Receiver<Option<i32>> {
        self.core.exited.subscribe()
    }

    /// Shut the daemon down: mark the exit expected, close stdin (the
    /// parent-death lease), then let the supervisor enforce the 3s kill
    /// grace. Idempotent; always terminates (the supervisor's kill fallback
    /// bounds it), with a safety timeout on our side.
    pub async fn dispose(&self) {
        if !self.core.disposed.swap(true, Ordering::SeqCst) {
            // Close stdin by dropping the handle → EOF lease.
            {
                let mut guard = self.core.stdin.lock();
                *guard = None;
            }
            self.core.dispose.cancel();
        }
        let mut rx = self.core.exited.subscribe();
        if rx.borrow().is_none() {
            let _ = tokio::time::timeout(DISPOSE_WAIT_BOUND, rx.changed()).await;
        }
    }
}

/// Supervision task owning the child: waits for natural exit, or — when a
/// dispose was signalled — races stdin-EOF shutdown against the 3s grace and
/// hard-kills on expiry. Publishes the exit code so `dispose()` (and the
/// pool's exit watcher) can observe it. tokio's `Child::wait` keeps reaping
/// state across cancellation, so the `select!` re-poll is safe.
async fn supervise_daemon_exit(core: Arc<DaemonCore>, mut child: Child) {
    let exit_code = tokio::select! {
        _ = core.dispose.cancelled() => {
            match tokio::time::timeout(DISPOSE_SIGKILL_AFTER, child.wait()).await {
                Ok(Ok(status)) => status.code(),
                Ok(Err(_)) => None,
                Err(_elapsed) => {
                    let _ = child.kill().await;
                    child.wait().await.ok().and_then(|status| status.code())
                }
            }
        }
        status = child.wait() => status.ok().and_then(|status| status.code()),
    };
    let code = exit_code.unwrap_or(-1);
    let _ = core.exited.send(Some(code));
    log::debug!("[canvas] daemon exited code={code}");
}

/// Keep draining a daemon pipe to EOF (cloudflared issue #593 pattern):
/// closing the read end early EPIPEs the daemon on its next write. Lines are
/// token-redacted, capped, and logged at debug only.
fn spawn_drain_task<R>(reader: BufReader<R>, token: String, tag: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = reader;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let redacted = line.replace(&token, "<redacted>");
                    let capped: String = redacted.chars().take(DRAIN_LINE_CAP).collect();
                    log::debug!("[canvas] {tag}: {capped}");
                }
            }
        }
    });
}

/// Spawn a managed-mode daemon from an arbitrary command (production callers
/// pass the resolved binary + managed argv; tests pass short-lived children
/// that print a handshake line). Applies the cloudflared stdio pattern
/// (piped stdio, `kill_on_drop`, Windows background flag), reads the first
/// stdout line under `handshake_timeout`, kills the child on any failure,
/// and keeps draining stdout/stderr to EOF after a successful handshake.
///
/// The returned daemon's child is owned by the internal supervision task —
/// `dispose()` is the only shutdown path.
pub(crate) async fn spawn_daemon_from_command(
    doc_key: &str,
    allow_origin: &str,
    mut command: Command,
    handshake_timeout: Duration,
) -> Result<Arc<CanvasDaemon>, CanvasError> {
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_background_command(&mut command);

    let mut child = command.spawn().map_err(|e| {
        let code = if e.kind() == std::io::ErrorKind::NotFound {
            CODE_BINARY_NOT_FOUND
        } else {
            CODE_SPAWN_FAILED
        };
        log::warn!("[canvas] daemon spawn failed: {e}");
        CanvasError::new(code, format!("failed to spawn op-host-web-server: {e}"))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CanvasError::new(CODE_SPAWN_FAILED, "daemon stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CanvasError::new(CODE_SPAWN_FAILED, "daemon stderr pipe missing"))?;

    // First stdout line = handshake. Timeout / early EOF / garbage all kill
    // the child before returning — no orphaned daemon.
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let handshake = match tokio::time::timeout(handshake_timeout, reader.read_line(&mut line)).await
    {
        Err(_) => Err(CanvasError::new(
            CODE_HANDSHAKE_TIMEOUT,
            format!(
                "daemon handshake not received within {}s",
                handshake_timeout.as_secs()
            ),
        )),
        Ok(Err(e)) => Err(CanvasError::new(
            CODE_HANDSHAKE_INVALID,
            format!("daemon stdout error before handshake: {e}"),
        )),
        Ok(Ok(0)) => Err(CanvasError::new(
            CODE_HANDSHAKE_INVALID,
            "daemon exited before producing a handshake line",
        )),
        Ok(Ok(_)) => parse_handshake_line(&line),
    };
    let handshake = match handshake {
        Ok(handshake) => handshake,
        Err(err) => {
            let _ = child.kill().await;
            log::warn!(
                "[canvas] daemon handshake rejected doc={doc_key} code={}",
                err.code
            );
            return Err(err);
        }
    };

    let stdin = child.stdin.take();
    // Keep draining both pipes to EOF (the handshake reader owns stdout).
    spawn_drain_task(reader, handshake.token.clone(), "daemon stdout");
    spawn_drain_task(BufReader::new(stderr), handshake.token.clone(), "daemon stderr");

    let (exited_tx, _exited_rx) = watch::channel(None);
    let core = Arc::new(DaemonCore {
        stdin: parking_lot::Mutex::new(stdin),
        dispose: CancellationToken::new(),
        exited: exited_tx,
        disposed: AtomicBool::new(false),
    });
    let daemon = Arc::new(CanvasDaemon {
        doc_key: doc_key.to_string(),
        allow_origin: allow_origin.to_string(),
        port: handshake.port,
        token: handshake.token,
        version: handshake.version,
        core: core.clone(),
    });
    tokio::spawn(supervise_daemon_exit(core, child));
    log::info!(
        "[canvas] daemon spawned doc={doc_key} port={} version={}",
        daemon.port,
        daemon.version
    );
    Ok(daemon)
}

/// Test-only daemon handle with a hand-picked port and no real child — used
/// by the proxy tests to point at a local echo server.
#[cfg(test)]
pub(crate) fn synthetic_daemon(doc_key: &str, port: u16, allow_origin: &str) -> Arc<CanvasDaemon> {
    let (exited_tx, _exited_rx) = watch::channel(None);
    Arc::new(CanvasDaemon {
        doc_key: doc_key.to_string(),
        allow_origin: allow_origin.to_string(),
        port,
        token: "test-token".to_string(),
        version: "0.8.5-test".to_string(),
        core: Arc::new(DaemonCore {
            stdin: parking_lot::Mutex::new(None),
            dispose: CancellationToken::new(),
            exited: exited_tx,
            disposed: AtomicBool::new(false),
        }),
    })
}

// ---------------------------------------------------------------------------
// Spawn seam
// ---------------------------------------------------------------------------

/// Injected spawn seam so pool supervision is testable without the sibling
/// OpenPencil checkout (tests spawn real short-lived children that print a
/// handshake line).
pub trait DaemonSpawner: Send + Sync + 'static {
    fn spawn(
        &self,
        doc_key: &str,
        allow_origin: &str,
    ) -> BoxFuture<'static, Result<Arc<CanvasDaemon>, CanvasError>>;
}

/// Production spawner: resolves the binary, builds the managed argv, applies
/// the checkout bundle env, and runs the spawn + handshake contract.
pub struct RealDaemonSpawner;

impl DaemonSpawner for RealDaemonSpawner {
    fn spawn(
        &self,
        doc_key: &str,
        allow_origin: &str,
    ) -> BoxFuture<'static, Result<Arc<CanvasDaemon>, CanvasError>> {
        let doc_key = doc_key.to_string();
        let allow_origin = allow_origin.to_string();
        async move {
            let resolved = resolve_daemon_binary()?;
            let mut command = Command::new(&resolved.binary);
            command.args(build_managed_argv(&doc_key, &allow_origin));
            if let Some(root) = &resolved.bundle_root {
                apply_bundle_env(&mut command, root);
            }
            spawn_daemon_from_command(&doc_key, &allow_origin, command, HANDSHAKE_TIMEOUT).await
        }
        .boxed()
    }
}
