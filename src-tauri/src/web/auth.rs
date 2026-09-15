//! Fail-closed web auth gate (QA remediation Story 1 — CAP-1 interim, NOT the
//! Epic-2 identity/authz model).
//!
//! One shared semantic for the single-token gate, consumed by `/ws`
//! (`ws.rs` `authenticate` handling), `/terminal/ws` (`terminal_ws.rs`
//! connection gate), and the HTTP API middleware (`router.rs`):
//!
//! - **Engagement rule:** the gate is active ⇔ an explicit token is
//!   configured (`--web-auth-token` / `$TERMUL_WEB_AUTH_TOKEN`) OR the bind is
//!   non-loopback (`--host 0.0.0.0`). Auto-generation fires ONLY on public
//!   binds, so loopback dev servers never gain a gate and never even read the
//!   token file (leftover state cannot change loopback behavior).
//! - **Public bind + no configured token:** a token is generated from the OS
//!   CSPRNG, persisted to `<state dir>/web-auth-token` with mode 0600, and
//!   printed to stdout exactly once by the caller (`server_main`). On the next
//!   boot the same token is loaded silently (no secret in logs).
//! - **Fail closed:** a public bind whose token can be neither resolved nor
//!   persisted (unreadable/empty token file, unwritable state dir, CSPRNG
//!   failure) is a startup error — the binary aborts BEFORE binding.
//! - The token is never logged. [`WebAuthToken`]'s `Debug` impl redacts; the
//!   only disclosure is the one-time `println!` banner at generation.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use subtle::ConstantTimeEq;

use crate::web::config::BindMode;

/// Token file name under the service-account state dir
/// (`ServerConfig::service_account_state_dir()`).
pub const WEB_AUTH_TOKEN_FILE: &str = "web-auth-token";

/// A web auth bearer token. `Debug` redacts the secret; use
/// [`WebAuthToken::as_str`] only at the compare site and the one-time
/// generation banner.
#[derive(Clone, PartialEq, Eq)]
pub struct WebAuthToken(String);

impl WebAuthToken {
    /// Build a token from raw input (CLI flag, env var, or persisted file
    /// contents). Surrounding whitespace is trimmed; an empty result is NOT a
    /// token (`None`) — callers decide whether empty is a parse error (CLI
    /// flag), ignored (env var), or a startup failure (persisted file).
    #[must_use]
    pub fn new(raw: impl AsRef<str>) -> Option<Self> {
        let trimmed = raw.as_ref().trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(Self(trimmed.to_string()))
        }
    }

    /// The raw token. Never log this.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for WebAuthToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebAuthToken(***)")
    }
}

/// The active gate: one bearer token, compared in constant time.
pub struct WebAuth {
    token: WebAuthToken,
}

impl WebAuth {
    #[must_use]
    pub fn new(token: WebAuthToken) -> Self {
        Self { token }
    }

    /// Constant-time acceptance check. A missing/empty presented token never
    /// matches (the configured token is non-empty by construction).
    #[must_use]
    pub fn accepts(&self, presented: &str) -> bool {
        self.token.0.as_bytes().ct_eq(presented.as_bytes()).into()
    }

    /// Reveal the raw token. Exists ONLY for the one-time generation banner
    /// in `server_main` — never log the return value.
    #[must_use]
    pub fn reveal_for_banner(&self) -> &str {
        self.token.as_str()
    }
}

impl std::fmt::Debug for WebAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebAuth(***)")
    }
}

/// Where a gated server's token came from (drives the startup log/banner in
/// `server_main`; the secret itself is only printed for [`Generated`]).
#[derive(Debug)]
pub enum WebAuthOrigin {
    /// Operator-supplied (`--web-auth-token` / `$TERMUL_WEB_AUTH_TOKEN`).
    Configured,
    /// Loaded from the persisted token file (path recorded for the log line).
    Loaded(PathBuf),
    /// Freshly generated + persisted this boot (path recorded for the banner).
    Generated(PathBuf),
}

/// The startup resolution of the web auth gate.
pub enum WebAuthResolution {
    /// No gate: loopback bind with no configured token. Behavior is
    /// byte-identical to the pre-gate server.
    Ungated,
    /// Gate active: require the token on `/ws` authenticate, `/terminal/ws`
    /// operations, and every gated HTTP API route.
    Gated { auth: Arc<WebAuth>, origin: WebAuthOrigin },
}
// Debug for test assertions (`unwrap_err`); the token itself stays redacted.
impl std::fmt::Debug for WebAuthResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ungated => f.write_str("WebAuthResolution::Ungated"),
            Self::Gated { origin, .. } => write!(f, "WebAuthResolution::Gated({origin:?})"),
        }
    }
}

/// Resolve the web auth posture for this boot.
///
/// - `configured: Some` → gated, regardless of bind mode (explicit opt-in,
///   honored on loopback too).
/// - Loopback bind (or unparseable host — already rejected at CLI parse) with
///   no configured token → ungated; the token file is NOT touched.
/// - Public bind with no configured token → load the persisted token, or
///   generate + persist one. Any failure to resolve/persist is `Err` — the
///   caller aborts startup before binding (fail closed).
pub fn resolve(
    bind_mode: Option<BindMode>,
    configured: Option<WebAuthToken>,
    state_dir: &Path,
) -> Result<WebAuthResolution, String> {
    if let Some(token) = configured {
        return Ok(WebAuthResolution::Gated {
            auth: Arc::new(WebAuth::new(token)),
            origin: WebAuthOrigin::Configured,
        });
    }
    if bind_mode != Some(BindMode::All) {
        return Ok(WebAuthResolution::Ungated);
    }

    let path = state_dir.join(WEB_AUTH_TOKEN_FILE);
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let token = WebAuthToken::new(&contents).ok_or_else(|| {
                format!(
                    "web auth token file '{}' is empty. Refusing to start a public-bind \
                     server without a token. Fix: write a non-empty token into the file, \
                     pass --web-auth-token, or delete the file to generate a fresh one.",
                    path.display()
                )
            })?;
            Ok(WebAuthResolution::Gated {
                auth: Arc::new(WebAuth::new(token)),
                origin: WebAuthOrigin::Loaded(path),
            })
        }
        // NotFound: no token file yet → generate. NotADirectory: the state
        // dir path is occupied by a regular file — ALSO route to generation
        // so the failure surfaces at `persist_token` with the explicit
        // state-dir remediation (fail closed).
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            let token = generate_token()?;
            match persist_token(&path, &token) {
                Ok(()) => Ok(WebAuthResolution::Gated {
                    auth: Arc::new(WebAuth::new(token)),
                    origin: WebAuthOrigin::Generated(path),
                }),
                // Lost a first-boot race with another termul-server instance:
                // adopt the winner's persisted token instead of failing or
                // clobbering it.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let contents = std::fs::read_to_string(&path).map_err(|e| {
                        format!(
                            "web auth token file '{}' appeared concurrently but is \
                             unreadable: {e}",
                            path.display()
                        )
                    })?;
                    let token = WebAuthToken::new(&contents).ok_or_else(|| {
                        format!(
                            "web auth token file '{}' appeared concurrently but is empty",
                            path.display()
                        )
                    })?;
                    Ok(WebAuthResolution::Gated {
                        auth: Arc::new(WebAuth::new(token)),
                        origin: WebAuthOrigin::Loaded(path),
                    })
                }
                Err(e) => Err(format!(
                    "failed to persist the generated web auth token: {e}. Refusing to \
                     start a public-bind server without a persistable token. Fix the \
                     state dir permissions, or pass --web-auth-token.",
                )),
            }
        }
        Err(e) => Err(format!(
            "failed to read web auth token file '{}': {e}. Refusing to start a \
             public-bind server without a token. Fix the file's permissions/contents, \
             or delete it to generate a fresh token.",
            path.display()
        )),
    }
}

/// Generate a fresh token from the OS CSPRNG (32 bytes, hex-encoded — 64
/// chars, URL-safe so the `?token=` hint needs no encoding).
fn generate_token() -> Result<WebAuthToken, String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|e| format!("failed to generate a web auth token (CSPRNG error): {e}"))?;
    let mut hex = String::with_capacity(raw.len() * 2);
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    // 64 hex chars is never empty — `expect` would be fine, but stay total.
    WebAuthToken::new(&hex)
        .ok_or_else(|| "generated web auth token was empty (internal error)".to_string())
}

/// Persist `token` to `path` with owner-only permissions (0600 on Unix),
/// creating the parent state dir if needed. Fails closed: any I/O error is
/// surfaced so the caller aborts startup rather than running a public-bind
/// server with an unpersisted (unrecoverable) token. `AlreadyExists` is
/// returned verbatim so the caller can adopt the winner of a first-boot race.
fn persist_token(path: &Path, token: &WebAuthToken) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        // A failure here is a state-dir problem (permissions / not a
        // directory) — never a first-boot race. Force a non-`AlreadyExists`
        // kind so `resolve` doesn't misread it as "token file appeared".
        std::fs::create_dir_all(parent).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("cannot create state dir '{}': {e}", parent.display()),
            )
        })?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(token.as_str().as_bytes())
        .and_then(|()| file.write_all(b"\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir per test (removed on Drop, including panic paths).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "termul-web-auth-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn token_debug_redacts_secret() {
        let token = WebAuthToken::new("super-secret-value").expect("non-empty");
        let dbg = format!("{token:?}");
        assert!(!dbg.contains("super-secret-value"), "debug must redact: {dbg}");
        let auth = WebAuth::new(token);
        let dbg = format!("{auth:?}");
        assert!(!dbg.contains("super-secret-value"), "debug must redact: {dbg}");
    }

    #[test]
    fn token_new_trims_and_rejects_empty() {
        assert!(WebAuthToken::new("").is_none());
        assert!(WebAuthToken::new("   \n").is_none());
        assert_eq!(
            WebAuthToken::new("  abc \n").expect("non-empty").as_str(),
            "abc"
        );
    }

    #[test]
    fn accepts_exact_match_only() {
        let auth = WebAuth::new(WebAuthToken::new("t0ken").expect("non-empty"));
        assert!(auth.accepts("t0ken"));
        assert!(!auth.accepts("WRONG"));
        assert!(!auth.accepts(""));
        // Length-mismatched and prefix probes must not match.
        assert!(!auth.accepts("t0ken-plus-extra"));
        assert!(!auth.accepts("t0k"));
    }

    #[test]
    fn resolve_configured_token_gates_even_on_loopback() {
        let dir = TempDir::new("configured");
        let resolution = resolve(
            Some(BindMode::Localhost),
            WebAuthToken::new("explicit"),
            &dir.0,
        )
        .expect("resolve");
        match resolution {
            WebAuthResolution::Gated { auth, origin } => {
                assert!(matches!(origin, WebAuthOrigin::Configured));
                assert!(auth.accepts("explicit"));
                assert!(!auth.accepts("other"));
            }
            WebAuthResolution::Ungated => panic!("configured token must gate"),
        }
        // The token file is never touched for a configured token.
        assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
    }

    #[test]
    fn resolve_loopback_without_token_is_ungated_and_file_free() {
        let dir = TempDir::new("loopback");
        let resolution = resolve(Some(BindMode::Localhost), None, &dir.0).expect("resolve");
        assert!(
            matches!(resolution, WebAuthResolution::Ungated),
            "loopback without a configured token must stay ungated"
        );
        // Frozen contract: the token file is not even read/created.
        assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
    }

    #[test]
    fn resolve_public_bind_generates_then_loads_same_token() {
        let dir = TempDir::new("generated");
        let first = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
        let WebAuthResolution::Gated {
            auth: first_auth,
            origin: WebAuthOrigin::Generated(path),
        } = first
        else {
            panic!("first public boot must generate")
        };
        assert_eq!(path, dir.0.join(WEB_AUTH_TOKEN_FILE));
        // Persisted contents match the live token.
        let on_disk = std::fs::read_to_string(&path).expect("token file exists");
        assert_eq!(on_disk.trim(), first_auth.reveal_for_banner());
        // Unix: owner-only permissions.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "token file must be 0600, got {mode:o}");
        }
        // Second boot loads the SAME token (no regeneration).
        let second = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
        let WebAuthResolution::Gated {
            auth: second_auth,
            origin: WebAuthOrigin::Loaded(_),
        } = second
        else {
            panic!("second public boot must load")
        };
        assert!(second_auth.accepts(first_auth.reveal_for_banner()));
    }

    #[test]
    fn resolve_public_bind_rejects_empty_token_file() {
        let dir = TempDir::new("empty-file");
        std::fs::write(dir.0.join(WEB_AUTH_TOKEN_FILE), "  \n").expect("write empty file");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(err.contains("empty"), "error must name the cause: {err}");
        assert!(
            err.contains(WEB_AUTH_TOKEN_FILE),
            "error must name the file: {err}"
        );
    }

    #[test]
    fn resolve_public_bind_rejects_unreadable_token_file() {
        // A directory at the token-file path fails `read_to_string` on every
        // platform, regardless of the test user's privileges (root bypasses
        // permission bits, so chmod-based unreadable fixtures are unreliable).
        let dir = TempDir::new("unreadable-file");
        std::fs::create_dir(dir.0.join(WEB_AUTH_TOKEN_FILE)).expect("mkdir at token path");
        let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
        assert!(
            err.contains("failed to read"),
            "error must name the cause: {err}"
        );
    }

    #[test]
    fn resolve_public_bind_fails_closed_when_state_dir_unwritable() {
        // A regular FILE at the state-dir path makes `create_dir_all` fail on
        // every platform, regardless of privileges (root bypasses permission
        // bits, so a chmod-based read-only dir is unreliable).
        let dir = TempDir::new("fail-closed");
        let state_dir = dir.0.join("state-is-a-file");
        std::fs::write(&state_dir, "not a directory").expect("write file");
        let err = resolve(Some(BindMode::All), None, &state_dir).unwrap_err();
        assert!(
            err.contains("cannot create state dir"),
            "error must name the cause: {err}"
        );
        assert!(
            err.contains("--web-auth-token"),
            "error must name the remediation: {err}"
        );
    }

    #[test]
    fn generated_tokens_are_unique_and_url_safe() {
        let a = generate_token().expect("generate");
        let b = generate_token().expect("generate");
        assert_ne!(a.as_str(), b.as_str(), "CSPRNG tokens must differ");
        assert_eq!(a.as_str().len(), 64);
        assert!(
            a.as_str().chars().all(|c| c.is_ascii_hexdigit()),
            "hex tokens need no URL encoding for the ?token= hint"
        );
    }
}
