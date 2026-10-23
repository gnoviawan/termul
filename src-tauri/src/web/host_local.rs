//! The host-local credential: proof that a `/ws` client runs as the user who
//! started the server, not merely that its socket comes from loopback.
//!
//! A reverse proxy (Caddy, nginx) or a tunnel (cloudflared) on the same host
//! makes every remote client a loopback peer, so the peer address and the
//! bearer token cannot grant the host's own credentials (Claude accounts, SSH
//! keys). At start the server writes a fresh random credential to
//! `<state dir>/host-local.token`, readable by the owner only. A client that
//! presents it at `authenticate` (the GPUIX launcher reads the file) is
//! `host_local`; a browser never can, so browser tabs stay without the
//! host-credential features.

use std::path::{Path, PathBuf};

use crate::web::auth::{generate_token, persist_token, WebAuthToken};

/// The credential file under the server's state dir.
pub const HOST_LOCAL_TOKEN_FILE: &str = "host-local.token";

/// Mint a credential and write it to `<state_dir>/host-local.token` (mode
/// 0600, replacing the previous boot's). Returns the credential and the path.
///
/// # Errors
/// The CSPRNG failed or the file could not be written; the server then runs
/// without host-local clients.
pub fn issue(state_dir: &Path) -> Result<(WebAuthToken, PathBuf), String> {
    let credential = generate_token()?;
    let path = state_dir.join(HOST_LOCAL_TOKEN_FILE);
    let staging = state_dir.join(format!("{HOST_LOCAL_TOKEN_FILE}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&staging);
    persist_token(&staging, &credential)
        .and_then(|()| std::fs::rename(&staging, &path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&staging);
            format!("cannot write the host-local credential to {}: {error}", path.display())
        })?;
    Ok((credential, path))
}
