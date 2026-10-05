//! Give Termul-launched OpenCode its own sqlite file.
//!
//! OpenCode 1.18 refuses to start when its shared database has tables but no
//! `session` table. That file is the user's existing OpenCode data, and the
//! process exits before `initialize`. A private database lets the chat start.

use std::path::{Path, PathBuf};

use super::config::AgentConfig;

const DB_ENV: &str = "OPENCODE_DB";

pub(crate) fn is_opencode(config: &AgentConfig) -> bool {
    if config.config_id.as_deref() == Some("acp-registry:opencode") {
        return true;
    }
    let Some(name) = Path::new(&config.command)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    name.eq_ignore_ascii_case("opencode") || name.eq_ignore_ascii_case("opencode.exe")
}

/// Point OpenCode at Termul's database unless the launch config already set one.
pub(crate) fn isolate(config: &mut AgentConfig) -> Result<(), String> {
    let Some(root) = app_data_dir() else {
        return Ok(());
    };
    isolate_at(config, &root)
}

pub(crate) fn isolate_at(config: &mut AgentConfig, data_dir: &Path) -> Result<(), String> {
    if !is_opencode(config) || config.env.contains_key(DB_ENV) {
        return Ok(());
    }
    let directory = data_dir.join("opencode");
    std::fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "could not create OpenCode data directory {}: {error}",
            directory.display()
        )
    })?;
    let database = directory.join("opencode.db");
    log::info!(
        "[acp] opencode using its own database at {}",
        database.display()
    );
    config
        .env
        .insert(DB_ENV.to_string(), database.to_string_lossy().into_owned());
    Ok(())
}

fn app_data_dir() -> Option<PathBuf> {
    if let Some(override_dir) = std::env::var_os("TERMUL_APP_DATA_DIR") {
        return Some(PathBuf::from(override_dir));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let home = PathBuf::from(home);
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.termul-manager.app")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("com.termul-manager.app")
    } else {
        home.join(".local/share/com.termul-manager.app")
    };
    Some(dir)
}

#[cfg(test)]
mod tests;
