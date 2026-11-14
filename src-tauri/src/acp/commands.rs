//! Host-local `#[tauri::command]`s of the ACP stack.
//!
//! Everything with a `/ws` request type (agents, sessions, prompts,
//! permissions, catalog, install) is served by the shared `/ws` dispatch over
//! the desktop's `ipc::Channel` carrier (`web::ws::channel`), not by a command
//! here. What stays is host-local by design: Claude Account management, the
//! factory key, the Codex CLI login probe, runtime and MCP probes, MCP OAuth,
//! and the ACP timeout overrides.

use std::sync::Arc;

use tauri::State;

use crate::acp::config::AgentConfig;
use crate::acp::manager::AcpManager;
use crate::acp::safe_url::{check_safe_url, Opener, MCP_UNSAFE_URL};
use crate::commands::IpcResult;

mod claude_accounts;
pub use claude_accounts::*;

mod codex_accounts;
pub use codex_accounts::*;

/// Whether the host OS keychain currently holds a Factory Droid API key.
#[tauri::command]
pub fn acp_factory_key_status() -> bool {
    crate::acp::factory_key::configured()
}

/// Validate a candidate through ACP before committing it to the host keychain.
#[tauri::command]
pub async fn acp_factory_key_save(
    manager: State<'_, Arc<AcpManager>>,
    config: AgentConfig,
    key: String,
) -> Result<(), String> {
    crate::acp::factory_key::validate_and_save(&manager, config, key).await
}

/// Result of `codex login status`. `unavailable` means the `codex` binary
/// could not be run. The command never returns credential text.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliAuthStatus {
    pub state: String,
}

/// Ask the Codex CLI whether it has a saved login. This is the same store
/// `codex-acp` uses (`CODEX_HOME`, default `~/.codex`).
#[tauri::command]
pub async fn codex_cli_auth_status(codex_home: Option<String>) -> CodexCliAuthStatus {
    let state = match codex_login_status(codex_home, None, None).await {
        CodexLoginProbe::SignedIn => "signed-in",
        CodexLoginProbe::SignedOut => "signed-out",
        CodexLoginProbe::Unavailable => "unavailable",
    };
    log::info!("[acp] codex login status {state}");
    CodexCliAuthStatus {
        state: state.to_string(),
    }
}

pub(crate) enum CodexLoginProbe {
    SignedIn,
    SignedOut,
    Unavailable,
}

/// PATH the login probe searches, matching the spawned adapter.
/// A project `PATH` is the inherited side of `apply_fresh_path`.
fn codex_probe_search_path(project_path: Option<&str>) -> String {
    let mut env = std::collections::HashMap::new();
    if let Some(path) = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.insert("PATH".to_string(), path.to_string());
    }
    crate::pty::env_refresh::apply_fresh_path(&mut env);
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

/// Resolve `program` the way the spawned adapter finds `codex`.
/// An explicit path is kept. A bare name is the first executable on `search_path`.
fn resolve_codex_probe_program(
    program: &str,
    search_path: &str,
) -> crate::pty::manager::ResolvedProgram {
    let trimmed = program.trim();
    let explicit = trimmed.contains('/') || (cfg!(windows) && trimmed.contains('\\'));
    let candidate = if explicit {
        trimmed.to_string()
    } else {
        crate::acp::config::resolve_runtime_executable(trimmed, search_path)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string())
    };
    crate::pty::manager::resolve_spawn_program(&candidate)
        .unwrap_or_else(|_| crate::pty::manager::ResolvedProgram::new(candidate))
}

/// `codex login status` for one home. `None` uses the host default (`~/.codex`).
/// `codex_bin` is the executable the managed adapter will run (`CODEX_PATH`);
/// when it is absent the host `CODEX_PATH` is used, then `codex` on `PATH`.
/// `project_path` is the project env `PATH`. A bare executable is resolved
/// against that path merged with the login-shell PATH, the same PATH the
/// spawned adapter searches. Exit 0 is signed in, exit 1 is signed out, and
/// every other result is unavailable. The command's output is discarded and
/// never logged.
pub(crate) async fn codex_login_status(
    codex_home: Option<String>,
    codex_bin: Option<&str>,
    project_path: Option<&str>,
) -> CodexLoginProbe {
    let search_path = codex_probe_search_path(project_path);
    let program = codex_bin
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("CODEX_PATH")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "codex".to_string());
    let resolved = resolve_codex_probe_program(&program, &search_path);
    let mut command = tokio::process::Command::new(&resolved.program);
    // Polled from the account snapshot: never flash a console window.
    crate::process_util::background_command_hygiene(&mut command);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // The managed child does not receive these. The probe must not treat
        // a host API key as a ChatGPT login for the selected home.
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN");
    if !search_path.is_empty() {
        command.env("PATH", &search_path);
        #[cfg(windows)]
        command.env("Path", &search_path);
    }
    if let Some(home) = codex_home.filter(|value| !value.trim().is_empty()) {
        command.env("CODEX_HOME", home);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), command.status()).await {
        Ok(Ok(status)) if status.success() => CodexLoginProbe::SignedIn,
        // Exit 1 is the unauthenticated status, matching the Claude probe.
        // Any other nonzero status is a CLI failure, not a logout.
        Ok(Ok(status)) if status.code() == Some(1) => CodexLoginProbe::SignedOut,
        Ok(Ok(status)) => {
            log::warn!(
                "[acp] codex login status exited {}",
                status.code().unwrap_or(-1)
            );
            CodexLoginProbe::Unavailable
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            CodexLoginProbe::Unavailable
        }
        Ok(Err(error)) => {
            log::warn!("[acp] codex login status could not start: {error}");
            CodexLoginProbe::Unavailable
        }
        Err(_) => {
            log::warn!("[acp] codex login status timed out");
            CodexLoginProbe::Unavailable
        }
    }
}

/// Arguments of a ChatGPT device login. The command never takes an API key.
pub(crate) const CODEX_DEVICE_LOGIN_ARGS: &[&str] = &["login", "--device-auth"];

/// `codex logout` for one home. `None` uses the host default. Output is
/// discarded and never logged. `Ok` only on exit 0.
pub(crate) async fn codex_logout(codex_home: Option<String>) -> Result<(), String> {
    let mut command = codex_command(&["logout"], codex_home, None, None);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match tokio::time::timeout(std::time::Duration::from_secs(20), command.status()).await {
        Ok(Ok(status)) if status.success() => {
            log::info!("[acp] codex logout finished");
            Ok(())
        }
        Ok(Ok(status)) => {
            log::warn!("[acp] codex logout exited {}", status.code().unwrap_or(-1));
            Err("Codex sign-out did not finish".to_string())
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("Codex CLI is not installed or is not on PATH".to_string())
        }
        Ok(Err(error)) => {
            log::warn!("[acp] codex logout could not start: {error}");
            Err("Could not start Codex sign-out".to_string())
        }
        Err(_) => {
            log::warn!("[acp] codex logout timed out");
            Err("Codex sign-out timed out".to_string())
        }
    }
}

/// ChatGPT device login in the caller's terminal (`troupe-server codex account
/// login`). The CLI prints the code itself; Troupe never reads it.
pub(crate) fn run_codex_device_login(codex_home: Option<&std::path::Path>) -> Result<(), String> {
    let home = match codex_home {
        Some(dir) => Some(dir.to_str().ok_or_else(|| {
            log::warn!("[acp] codex account home is not valid Unicode");
            "The Codex account folder path is not supported".to_string()
        })?),
        None => None,
    };
    if let Some(dir) = home {
        if let Err(error) = std::fs::create_dir_all(dir) {
            log::warn!(
                "[acp] could not create Codex home before login: {:?}",
                error.kind()
            );
            return Err("Could not create the Codex home folder".to_string());
        }
    }
    let resolved = resolve_codex_program(None, None);
    let mut command = std::process::Command::new(&resolved.program);
    command
        .args(&resolved.prepend_args)
        .args(CODEX_DEVICE_LOGIN_ARGS);
    let mut path_env = std::collections::HashMap::new();
    crate::pty::env_refresh::apply_fresh_path(&mut path_env);
    if let Some(path) = path_env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.clone())
    {
        command.env("PATH", &path);
        #[cfg(windows)]
        command.env("Path", &path);
    }
    if let Some(dir) = home {
        command.env("CODEX_HOME", dir);
    }
    command.env_remove("OPENAI_API_KEY");
    command.env_remove("CODEX_ACCESS_TOKEN");
    let status = command
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .map_err(|error| {
            log::warn!("[acp] codex login could not start: {error}");
            if error.kind() == std::io::ErrorKind::NotFound {
                "Codex CLI is not installed or is not on PATH".to_string()
            } else {
                "Could not start Codex sign-in".to_string()
            }
        })?;
    if status.success() {
        log::info!("[acp] codex device login finished");
        Ok(())
    } else {
        log::warn!(
            "[acp] codex device login exited {}",
            status.code().unwrap_or(-1)
        );
        Err("Codex sign-in did not finish".to_string())
    }
}

/// `codex_bin` is `CODEX_PATH` from the agent env. When it is absent the host
/// `CODEX_PATH` is used, then `codex` on `PATH`. `project_path` is the project
/// env `PATH`. API credentials are removed so a host key is not treated as a
/// ChatGPT login.
fn codex_command(
    args: &[&str],
    codex_home: Option<String>,
    codex_bin: Option<&str>,
    project_path: Option<&str>,
) -> tokio::process::Command {
    let search_path = codex_probe_search_path(project_path);
    let resolved = resolve_codex_program(codex_bin, Some(search_path.as_str()));
    let mut command = tokio::process::Command::new(&resolved.program);
    crate::process_util::background_command_hygiene(&mut command);
    command
        .args(&resolved.prepend_args)
        .args(args)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN");
    if !search_path.is_empty() {
        command.env("PATH", &search_path);
        #[cfg(windows)]
        command.env("Path", &search_path);
    }
    if let Some(home) = codex_home.filter(|value| !value.trim().is_empty()) {
        command.env("CODEX_HOME", home);
    }
    command
}

pub(crate) fn resolve_codex_program(
    codex_bin: Option<&str>,
    search_path: Option<&str>,
) -> crate::pty::manager::ResolvedProgram {
    let program = codex_bin
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("CODEX_PATH")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "codex".to_string());
    let path = search_path
        .map(str::to_string)
        .unwrap_or_else(|| codex_probe_search_path(None));
    resolve_codex_probe_program(&program, &path)
}

/// Probe whether registry package-manager launchers (`npx` / `uvx`) are on PATH.
#[tauri::command]
pub fn acp_probe_runtime() -> crate::acp::config::AcpRuntimeProbe {
    crate::acp::config::probe_registry_runtime()
}

/// On-demand MCP client probe. Takes a renderer-supplied `McpServerConfig`
/// (stateless — no registry-store coupling), opens a fresh rmcp client
/// connection, calls `initialize` + `tools/list`, then closes, and returns
/// the connected/disconnected status + tool list. Never logs env/header
/// values, tokens, or credentials. Mirrors the stateless shape of
/// `acp_probe_runtime`.
#[tauri::command]
pub async fn acp_probe_mcp_server(
    server: crate::acp::mcp_probe::McpServerConfig,
) -> Result<crate::acp::mcp_probe::ProbeResult, String> {
    Ok(crate::acp::mcp_probe::probe(server).await)
}
/// Start the MCP OAuth flow for a server URL. Discovers the OAuth endpoints,
/// registers a client (PKCE), opens the authorization URL in the system
/// browser, and waits for the callback redirect on a local HTTP server.
/// Returns the stored token on success. Desktop-only: the standalone server
/// has no UI to drive the browser flow. An unsafe authorization URL is
/// refused with `MCP_UNSAFE_URL` and never opened (AD-15).
#[tauri::command]
pub async fn acp_mcp_oauth_start(
    app: tauri::AppHandle,
    server_url: String,
) -> Result<IpcResult<()>, String> {
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationRequest, AuthorizationSession};
    use std::net::TcpListener;
    use tauri_plugin_opener::OpenerExt;

    // Bind a local TCP listener on an OS-assigned port for the OAuth callback.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind callback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to get callback port: {e}"))?
        .port();
    let _owned_port = crate::host_perimeter::OwnedPort::claim(port);
    let redirect_uri = format!(
        "http://127.0.0.1:{port}{}",
        crate::acp::mcp_oauth::OAUTH_REDIRECT_PATH
    );

    // Set the listener to non-blocking so we can poll it with a timeout.
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to set non-blocking: {e}"))?;

    // 1. Create AuthorizationManager + discover metadata + register client
    let mut manager = AuthorizationManager::new(&server_url)
        .await
        .map_err(|e| format!("OAuth discovery failed: {e}"))?;
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|e| format!("OAuth discovery failed: {e}"))?;
    manager.set_metadata(resolution.metadata);

    // 2. Create the authorization session (handles dynamic registration + PKCE).
    //    The session holds the PKCE verifier in its InMemoryStateStore — we MUST
    //    keep it alive until the callback arrives, then use it for the token exchange.
    let request = AuthorizationRequest::new(&redirect_uri).with_client_name("Troupe");
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_manager, e)| format!("OAuth registration failed: {e}"))?;

    let auth_url = match host_auth_url(session.get_authorization_url()) {
        Ok(url) => url,
        Err(refusal) => return Ok(refusal),
    };

    log::info!(
        "[mcp-oauth] opening browser for server (url redacted), redirect_uri={redirect_uri}"
    );

    // 3. Open the authorization URL in the user's system browser.
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    // 4. Wait for the callback on the local TCP listener.
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(crate::acp::mcp_oauth::OAUTH_FLOW_TIMEOUT_SECS);
    let callback_url = loop {
        if std::time::Instant::now() > deadline {
            return Err(
                "OAuth flow timed out — user did not complete authorization in time".to_string(),
            );
        }
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                use std::io::{BufRead, BufReader, Write};
                // Accepted sockets inherit the listener's non-blocking mode;
                // the header block must be read whole for the Host check.
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                let reader = BufReader::new(&mut stream);
                let mut lines = reader.lines();
                if let Some(Ok(first_line)) = lines.next() {
                    if !crate::web::host_allow::HostAllowList::loopback()
                        .allows_header_block(&mut lines)
                    {
                        log::warn!(
                            "[mcp-oauth] rejected callback request: foreign or missing host"
                        );
                        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.flush();
                        continue;
                    }
                    // Parse the request target. Stray browser requests
                    // (preconnect, favicon, malformed) must not break the
                    // loop — only the callback path with a `code` param
                    // completes the flow. Respond to non-callback requests
                    // with a 404 and continue waiting.
                    let target = first_line.split(' ').nth(1).unwrap_or("/").to_string();
                    let path = target.split('?').next().unwrap_or("/");
                    let is_callback = path == crate::acp::mcp_oauth::OAUTH_REDIRECT_PATH
                        && target.contains("code=");
                    if !is_callback {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.flush();
                        continue;
                    }
                    let full_url = format!("http://127.0.0.1:{port}{target}");
                    let body = "<!DOCTYPE html><html><body><h2>Authorization complete</h2><p>You can close this tab and return to Troupe.</p><script>window.close();</script></body></html>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    break full_url;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(e) => {
                return Err(format!("callback listener error: {e}"));
            }
        }
    };
    // 5. Exchange the authorization code with the SAME session (it holds the
    //    PKCE verifier) and store the token. The desktop flow does not pass
    //    the callback's `iss` on to the issuer check.
    let callback = rmcp::transport::auth::AuthorizationCallback::from_redirect_url(&callback_url)
        .map_err(|e| format!("callback parse failed: {e}"))?;
    let stored = crate::acp::mcp_oauth::finish_session(
        &server_url,
        session,
        &callback.code,
        &callback.csrf_token,
        None,
    )
    .await
    .map_err(|e| {
        log::warn!("[mcp-oauth] OAuth token exchange failed (url redacted): {e}");
        e.to_string()
    })?;

    log::info!(
        "[mcp-oauth] OAuth flow completed for server (url redacted), has refresh token: {}",
        stored.refresh_token.is_some()
    );

    Ok(IpcResult::success(()))
}

fn host_auth_url(raw: &str) -> Result<url::Url, IpcResult<()>> {
    check_safe_url(raw, Opener::Host).map_err(|refused| {
        log::warn!("[mcp-oauth] authorization URL refused (url redacted): {refused}");
        IpcResult::error(refused.to_string(), MCP_UNSAFE_URL)
    })
}

/// Check whether a stored OAuth token exists for a server URL. Returns `true`
/// when a token is found (the renderer shows "Connected" / "Disconnect"
/// instead of "Connect"). Does NOT check token validity — the next probe
/// handles refresh/expiry transparently.
#[tauri::command]
pub fn acp_mcp_oauth_has_token(server_url: String) -> Result<bool, String> {
    Ok(crate::acp::mcp_oauth::load_stored_token(&server_url)
        .map(|t| t.is_some())
        .unwrap_or(false))
}

/// Delete the stored OAuth token for a server URL (the "Disconnect" action).
/// After this, the next probe will return `AuthRequired` again and the user
/// can re-connect.
#[tauri::command]
pub fn acp_mcp_oauth_disconnect(server_url: String) -> Result<(), String> {
    crate::acp::mcp_oauth::delete_stored_token(&server_url).map_err(|e| e.to_string())
}

/// Set the in-process ACP turn (hard-cap) timeout override, in seconds, or
/// `None` to clear it (fall back to the env var / unlimited default). Pushed from
/// the App Preferences UI so the turn timeout is editable without a restart or
/// env var. Desktop-only: the standalone `termul-server` has no settings
/// surface and configures via `TERMUL_ACP_TURN_TIMEOUT_SECS`. The env var
/// remains top-precedence (operator/diagnostic override).
#[tauri::command]
pub fn acp_set_turn_timeout(secs: Option<u64>) -> Result<(), String> {
    crate::acp::manager::set_turn_timeout_override(secs);
    Ok(())
}

/// Set the in-process ACP turn *idle* timeout override, in seconds, or `None`
/// to clear it (fall back to the env var / unlimited default). Pushed from the
/// App Preferences UI. Desktop-only parity with `acp_set_turn_timeout`: the
/// standalone `termul-server` configures via `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`.
/// The env var remains top-precedence (operator/diagnostic override).
#[tauri::command]
pub fn acp_set_turn_idle_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("turn idle timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_turn_idle_timeout_override(secs);
    log::info!("[acp] turn idle timeout override: {secs:?}");
    Ok(())
}

/// Set the in-process `session/new` timeout override, in seconds, or `None`
/// to clear it (fall back to the env var / 60s default). Pushed from the App
/// Preferences UI; same desktop-only + env-precedence contract as
/// `acp_set_turn_timeout` (`TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS` wins).
#[tauri::command]
pub fn acp_set_session_new_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("session/new timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_session_new_timeout_override(secs);
    log::info!("[acp] session/new timeout override: {secs:?}");
    Ok(())
}

/// Set the in-process `session/load` / `session/resume` timeout override, in
/// seconds, or `None` to clear it (fall back to the env var / 60s default).
/// Pushed from the App Preferences UI; same desktop-only + env-precedence
/// contract as `acp_set_turn_timeout`
/// (`TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` wins).
#[tauri::command]
pub fn acp_set_session_reopen_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("session reopen timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_session_reopen_timeout_override(secs);
    log::info!("[acp] session reopen timeout override: {secs:?}");
    Ok(())
}

/// Set how long an idle agent chat stays open, in seconds, or `None` to clear
/// the App Preferences override. `$TERMUL_AGENT_IDLE_REAP_SECS` and a locked
/// server window keep the live value. The reaper reads the result on its next
/// sweep.
#[tauri::command]
pub fn acp_set_agent_idle_window(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("agent idle window must be > 0 seconds".to_string());
    }
    crate::web::agent_reaper::set_agent_idle_window_override(secs);
    Ok(())
}

/// The idle window the host is using now (`secs` plus `source`: `env`,
/// `operator`, `setting`, or `default`).
#[tauri::command]
pub fn acp_get_agent_idle_window() -> crate::web::agent_reaper::AgentIdleWindowStatus {
    crate::web::agent_reaper::resolved_agent_idle_window()
}

#[cfg(test)]
mod tests;
