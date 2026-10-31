//! Durable server configuration file — the shared onboarding record (gh-1105).
//!
//! `termul-server` historically rebuilt its [`ServerConfig`] from argv/env on
//! every boot; "configured" existed only implicitly as a systemd unit's
//! `ExecStart`/`EnvironmentFile`. Web onboarding (and the CLI wizard, which
//! also writes this file) persists the operator's answers to
//! `<state_dir>/server-config.json`. For fields the file carries, the file
//! wins over argv/env — that is what makes a CLI-onboarded (argv-pinned)
//! install reconfigurable from the web. Fields absent from the file still
//! resolve from argv/env/defaults inside `ServerConfig::from_args`.
//!
//! This module is the shared contract between three slices:
//! - the `from_args` merge + `termul-server onboard` writer (config slice)
//! - the setup-mode router served before config exists (setup slice)
//! - the normal-mode `/server/config` reconfigure routes (router slice)

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::onboard::OnboardAnswers;
use crate::server_update::UpdateChannel;
use crate::web::config::{BindMode, ServerConfig};

/// Config file name under [`ServerConfig::service_account_state_dir`].
pub const SERVER_CONFIG_FILE_NAME: &str = "server-config.json";

/// The persisted onboarding record. Field names are camelCase on disk so the
/// file doubles as the wire shape for `ServerSetupAnswers` (the wizard and
/// the file must never drift — AGENTS.md "can't drift" requirement).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigFile {
    /// `127.0.0.1` or `0.0.0.0` (display form — same vocabulary as the CLI).
    pub host: String,
    pub port: u16,
    pub sessions_dir: PathBuf,
    pub projects_file: PathBuf,
    pub allow_remote_writes: bool,
    pub update_channel: Option<UpdateChannel>,
    pub update_interval_secs: u64,
}

impl ServerConfigFile {
    /// Recompose the answers the operator gave, for pre-filling the
    /// reconfigure form.
    pub fn into_answers(self) -> ServerSetupAnswers {
        ServerSetupAnswers {
            host: self.host,
            port: self.port,
            sessions_dir: self.sessions_dir,
            projects_file: self.projects_file,
            allow_remote_writes: self.allow_remote_writes,
            update_channel: self.update_channel,
            update_interval_secs: self.update_interval_secs,
        }
    }
}

/// The wire shape for the onboarding wizard and the `/server/config`
/// reconfigure form — identical fields to [`ServerConfigFile`].
pub type ServerSetupAnswers = ServerConfigFile;

/// Per-field validation errors returned by `POST /setup/validate`,
/// `POST /setup/apply`, and `POST /server/config`. Absent field = no error.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFieldErrors {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions_dir: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects_file: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_remote_writes: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_channel: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_interval_secs: Option<Box<str>>,
}

impl SetupFieldErrors {
    pub fn is_empty(&self) -> bool {
        self.host.is_none()
            && self.port.is_none()
            && self.sessions_dir.is_none()
            && self.projects_file.is_none()
            && self.allow_remote_writes.is_none()
            && self.update_channel.is_none()
            && self.update_interval_secs.is_none()
    }
}

/// Validate wizard answers with the SAME rules as the CLI wizard
/// (`onboard.rs::collect`), producing the file record on success.
///
/// Mirrors `OnboardAnswers` semantics:
/// - host must parse via [`BindMode::parse`] and is normalized to display form
/// - port must be non-zero
/// - sessions dir / projects file must be non-empty; a relative projects file
///   is made absolute against the server cwd (`normalize_projects_file_path`)
/// - `allow_remote_writes` is forced `false` on a loopback bind (documented
///   no-op there — same as `to_server_config`)
/// - `update_interval_secs` must be > 0 whenever a channel is set
pub fn validate_answers(
    answers: &ServerSetupAnswers,
) -> Result<ServerConfigFile, SetupFieldErrors> {
    let mut errors = SetupFieldErrors::default();

    let bind_mode = match BindMode::parse(&answers.host) {
        Some(mode) => Some(mode),
        None => {
            errors.host = Some(
                format!("invalid host '{}': use 127.0.0.1 or 0.0.0.0", answers.host).into(),
            );
            None
        }
    };

    if answers.port == 0 {
        errors.port = Some("invalid port '0': use 1-65535".into());
    }

    // Trim before the empty check — the CLI wizard trims its prompt input;
    // a whitespace-only value must not reach the persisted file (it would
    // resolve to a directory literally named "   " under the server cwd).
    if answers.sessions_dir.to_string_lossy().trim().is_empty() {
        errors.sessions_dir = Some("sessions directory cannot be empty".into());
    } else if answers
        .sessions_dir
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        // `..` makes the effective directory ambiguous — the server resolves
        // config paths verbatim at every boot, and every path it derives is
        // canonical.
        errors.sessions_dir = Some("sessions directory must not contain '..'".into());
    }
    // NOTE: no filesystem probe here (a file existing where the sessions dir
    // should be is caught by `load`'s `file_errors` on the next boot, which
    // treats the file as corrupt and recovers into setup mode — the apply
    // can never wedge the server). Wizard-supplied paths are never touched
    // on disk from the request path at all.

    let projects_file = if answers.projects_file.to_string_lossy().trim().is_empty() {
        errors.projects_file = Some(
            "projects registry file cannot be empty (no platform default — enter a path)".into(),
        );
        answers.projects_file.clone()
    } else if answers
        .projects_file
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        errors.projects_file = Some("projects registry file must not contain '..'".into());
        answers.projects_file.clone()
    } else {
        crate::onboard::normalize_projects_file_path(answers.projects_file.clone())
    };

    if answers.update_channel.is_some() && answers.update_interval_secs == 0 {
        errors.update_interval_secs = Some("interval must be > 0".into());
    }

    if !errors.is_empty() {
        return Err(errors);
    }

    let expose = bind_mode == Some(BindMode::All);
    Ok(ServerConfigFile {
        host: bind_mode
            .map(|m| m.display_host().to_string())
            .unwrap_or_else(|| answers.host.clone()),
        port: answers.port,
        sessions_dir: answers.sessions_dir.clone(),
        projects_file,
        allow_remote_writes: answers.allow_remote_writes && expose,
        update_channel: answers.update_channel,
        update_interval_secs: answers.update_interval_secs,
    })
}

impl From<&OnboardAnswers> for ServerConfigFile {
    /// The CLI wizard and the web wizard must persist identical shapes —
    /// onboard calls this so the two paths can never drift.
    fn from(a: &OnboardAnswers) -> Self {
        let expose = BindMode::parse(&a.host) == Some(BindMode::All);
        Self {
            host: BindMode::parse(&a.host)
                .map(|m| m.display_host().to_string())
                .unwrap_or_else(|| a.host.clone()),
            port: a.port,
            sessions_dir: a.sessions_dir.clone(),
            projects_file: a.projects_file.clone(),
            allow_remote_writes: a.allow_remote_writes && expose,
            update_channel: a.update_channel,
            update_interval_secs: a.update_interval_secs,
        }
    }
}

/// Absolute path of the config file inside a resolved state dir.
pub fn server_config_path(state_dir: &Path) -> PathBuf {
    state_dir.join(SERVER_CONFIG_FILE_NAME)
}

/// Read the config file. `Ok(None)` = never onboarded. `Err` = present but
/// unreadable/corrupt — callers treat that as "not configured" (setup mode
/// recovery) after logging it; the file is never silently ignored.
pub fn load(state_dir: &Path) -> std::io::Result<Option<ServerConfigFile>> {
    let path = server_config_path(state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let file: ServerConfigFile = serde_json::from_str(&text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{}: {e}", path.display()),
        )
    })?;
    // Semantically invalid content counts as corrupt too — a hand-edited
    // file carrying an unparseable host or port `0` would otherwise win the
    // `from_args` merge and wedge the boot (or silently bind an OS-assigned
    // port). Treating it as "not onboarded" lets setup mode recover.
    if let Err(problems) = file_errors(&file) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{}: {}", path.display(), problems.join(", ")),
        ));
    }
    Ok(Some(file))
}

/// Semantic field checks on a parsed [`ServerConfigFile`] — the same rules
/// `validate_answers` applies to wizard answers, PLUS the one filesystem
/// probe that prevents a wedge: a sessions dir that exists as a non-dir
/// fails `from_args`'s final guard BEFORE `setup_required` can run, which
/// makes the process exit on every boot — worse than corrupt. Flagging it
/// here recovers into setup mode instead. (File content is not request
/// input, so probing here is not a request-driven filesystem touch.)
fn file_errors(file: &ServerConfigFile) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    if BindMode::parse(&file.host).is_none() {
        problems.push(format!("invalid host '{}'", file.host));
    }
    if file.port == 0 {
        problems.push("port must not be 0".to_string());
    }
    if file.sessions_dir.to_string_lossy().trim().is_empty() {
        problems.push("sessionsDir must not be empty".to_string());
    } else if file.sessions_dir.exists() && !file.sessions_dir.is_dir() {
        problems.push(format!(
            "sessionsDir '{}' exists and is not a directory",
            file.sessions_dir.display()
        ));
    }
    if file.projects_file.to_string_lossy().trim().is_empty() {
        problems.push("projectsFile must not be empty".to_string());
    }
    // Deliberately no kind-probe on projectsFile: a directory there degrades
    // (the registry can't write) but the boot still succeeds — flagging the
    // file corrupt would bounce a working server into setup for nothing.
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// Whether a completed config exists (exists AND parses). The "are we in
/// setup mode" predicate — but callers that log should use [`load`] so a
/// corrupt file surfaces in the logs instead of silently re-entering setup.
pub fn is_onboarded(state_dir: &Path) -> bool {
    matches!(load(state_dir), Ok(Some(_)))
}

/// Atomically write the config file (`tmp` + rename) with owner-only
/// permissions on unix — the file can drive host security settings
/// (`allow_remote_writes`), so it gets the same 0600 treatment as
/// `web-auth-token`.
/// Serializes every `save` — two overlapping applies would otherwise share
/// the one `server-config.json.tmp` and could rename each other's write.
static SAVE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub fn save(state_dir: &Path, config: &ServerConfigFile) -> std::io::Result<()> {
    let _guard = SAVE_LOCK.lock();
    std::fs::create_dir_all(state_dir)?;
    let path = server_config_path(state_dir);
    let tmp = state_dir.join(format!("{SERVER_CONFIG_FILE_NAME}.tmp"));
    let text = serde_json::to_string_pretty(config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, &path)?;
    tracing::info!(
        target: "termul::server_config",
        path = %path.display(),
        "server config file written"
    );
    Ok(())
}

/// Resolved self-update settings. When the config file exists it is
/// authoritative for `channel`/`interval` (file-wins precedence); otherwise
/// the legacy env vars apply (`TERMUL_SERVER_UPDATE_ENABLED`,
/// `TERMUL_SERVER_UPDATE_CHANNEL`, `TERMUL_SERVER_UPDATE_INTERVAL_SECS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateSettings {
    pub enabled: bool,
    pub channel: Option<UpdateChannel>,
    pub interval_secs: u64,
}

pub const DEFAULT_UPDATE_INTERVAL_SECS: u64 = 21600;

pub fn resolve_update_settings(state_dir: &Path) -> UpdateSettings {
    if let Ok(Some(file)) = load(state_dir) {
        return UpdateSettings {
            enabled: file.update_channel.is_some(),
            channel: file.update_channel,
            interval_secs: file.update_interval_secs.max(1),
        };
    }
    let channel = std::env::var("TERMUL_SERVER_UPDATE_CHANNEL")
        .ok()
        .and_then(|v| UpdateChannel::parse(&v));
    let enabled = crate::server_update::is_update_enabled() && channel.is_some();
    let interval_secs = std::env::var("TERMUL_SERVER_UPDATE_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_UPDATE_INTERVAL_SECS);
    UpdateSettings {
        enabled,
        channel: if enabled { channel } else { None },
        interval_secs,
    }
}

/// The host-administration handle carried on `AppState` ONLY for the
/// standalone `termul-server` (`None` on the desktop shared-live host —
/// keeping `/server/config` and `setupRequired` unreachable there).
#[derive(Debug, Clone)]
pub struct ServerAdminContext {
    /// Resolved state dir — where the config file is read/written.
    pub state_dir: PathBuf,
    /// Effective answers the running server was configured with (for the
    /// reconfigure form's current values).
    pub current: ServerSetupAnswers,
    /// One apply at a time: set while a `POST /server/config` apply is in
    /// flight and stays set once a restart is scheduled — a second apply
    /// during the pending-restart window would save a config the client was
    /// never redirected to (the re-exec loads the last file written).
    pub apply_in_flight: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ServerAdminContext {
    /// Build from the already-merged runtime config. Called by `web::serve`
    /// (standalone only — `remote/host.rs` passes `None` to `serve_router`).
    pub fn from_config(cfg: &ServerConfig) -> Self {
        let update = resolve_update_settings(&cfg.service_account_state_dir());
        Self {
            state_dir: cfg.service_account_state_dir(),
            apply_in_flight: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            current: ServerSetupAnswers {
                host: cfg.host.clone(),
                port: cfg.port,
                sessions_dir: cfg.sessions_dir.clone().unwrap_or_default(),
                projects_file: cfg.projects_file.clone().unwrap_or_default(),
                allow_remote_writes: cfg.allow_remote_writes,
                update_channel: update.channel,
                update_interval_secs: update.interval_secs,
            },
        }
    }
}

/// Generate a fresh one-time setup token (URL-safe, 256-bit). Printed to
/// stdout/journal as part of the setup URL; never persisted. Uses the same
/// CSPRNG path as `web::auth::generate_token`.
pub fn generate_setup_token() -> Result<String, String> {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("failed to generate a setup token (CSPRNG error): {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Schedule the process self-reexec shortly AFTER the HTTP response has been
/// sent (the reply must reach the client before the sockets die). The new
/// process re-reads the config file at boot. `restart_binary` preserves the
/// PID via `exec`, so this works identically under systemd `Restart=on-failure`
/// and `setsid`. On non-unix it errors — logged, never fatal to the response.
///
/// Uses `current_exe()` (NOT a stored install path): no `atomic_swap` has
/// happened, so `/proc/self/exe` still resolves to the running binary.
pub fn schedule_self_restart(reason: &'static str) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        match std::env::current_exe() {
            Ok(exe) => {
                tracing::info!(
                    target: "termul::server_config",
                    reason,
                    "restarting termul-server to apply new config"
                );
                if let Err(e) = crate::server_update::restart_binary(&exe) {
                    tracing::error!(
                        target: "termul::server_config",
                        "self-restart failed: {e}"
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    target: "termul::server_config",
                    "self-restart failed — cannot resolve current_exe: {e}"
                );
            }
        }
    });
}
