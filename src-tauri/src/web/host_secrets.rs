//! Host files the HTTP file routes never serve: credentials that grant more
//! than the bearer token a request already carries.
//!
//! The `/fs/*` routes resolve any absolute path (ADR-007), so without this
//! list a bearer-token holder could read `<state dir>/host-local.token` and
//! present it at `authenticate` to become `host_local`. Each writer of such a
//! file registers it here at boot ([`protect_state_dir`]); the file routes,
//! the search routes and the fs watch consult [`snapshot`].
//!
//! This guards honest clients and the cheap path. It is not a boundary
//! against a token holder: a bearer token opens a terminal running as the
//! server's user, and that shell reads the file directly. A real boundary
//! would need the peer's credentials (`SO_PEERCRED` on a Unix socket).

use std::path::{Path, PathBuf};

use parking_lot::RwLock;

/// Every protected file or directory, as registered. Append-only: a boot
/// registers its state dirs once, and tests register their own temp dirs, so
/// entries never conflict.
static PROTECTED: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

/// The credential files and directories a host state dir holds.
///
/// `web-auth-token` is the bearer token itself, `host-local.token` (and the
/// staging file `host_local::issue` renames over it) proves host-locality,
/// and the Claude Account store plus its config directories hold each
/// Account's login. `ssh-profiles.json` holds no secret (passwords and
/// passphrases live in the OS keychain), and `termul-server.env` holds only
/// `SHELL`, `HOME` and update settings.
fn state_dir_secrets(state_dir: &Path) -> Vec<PathBuf> {
    vec![
        state_dir.join(crate::web::auth::WEB_AUTH_TOKEN_FILE),
        state_dir.join(crate::web::host_local::HOST_LOCAL_TOKEN_FILE),
        crate::web::host_local::staging_path(state_dir),
        state_dir.join(crate::acp::claude_accounts::STORE_FILE_NAME),
        state_dir.join(crate::acp::claude_accounts::ACCOUNTS_DIR_NAME),
    ]
}

/// Register the credential files of `state_dir`. Idempotent.
pub fn protect_state_dir(state_dir: &Path) {
    let mut protected = PROTECTED.write();
    for path in state_dir_secrets(state_dir) {
        if !protected.contains(&path) {
            protected.push(path);
        }
    }
}

/// The protected paths resolved against the filesystem now, so a symlinked
/// state dir or one created after registration still matches the
/// canonicalized request paths of the file routes.
#[must_use]
pub fn snapshot() -> HostSecrets {
    let resolved = PROTECTED
        .read()
        .iter()
        .map(|path| canonical(path))
        .collect();
    HostSecrets(resolved)
}

/// The canonical form of `path`, or of its parent joined with its name when
/// `path` does not exist yet, or `path` itself.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map_or_else(|_| path.to_path_buf(), |parent| parent.join(name)),
        _ => path.to_path_buf(),
    }
}

/// A point-in-time view of the protected paths, all canonical.
#[derive(Debug, Default)]
pub struct HostSecrets(Vec<PathBuf>);

impl HostSecrets {
    /// `path` (canonical) is a protected file or lies inside a protected
    /// directory. Reading, writing or listing it is refused.
    #[must_use]
    pub fn covers(&self, path: &Path) -> bool {
        self.0.iter().any(|secret| path.starts_with(secret))
    }

    /// `path` (canonical) is covered, or is a directory that contains a
    /// protected path, so moving or copying it would carry a credential to
    /// an unprotected location.
    #[must_use]
    pub fn exposes(&self, path: &Path) -> bool {
        self.covers(path) || self.0.iter().any(|secret| secret.starts_with(path))
    }
}
