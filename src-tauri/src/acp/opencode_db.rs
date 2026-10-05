//! Choose the sqlite file a Termul-launched OpenCode process opens.
//!
//! Provider accounts live in the same database as sessions. The CLI writes
//! them to its own file (`~/.local/share/opencode/opencode.db` for a release
//! build, or `$XDG_DATA_HOME/opencode/opencode.db`). Leaving `OPENCODE_DB`
//! unset makes the agent read that file, so models from `/connect` show up
//! in the picker.
//!
//! OpenCode exits before `initialize` when that file already has tables but
//! no `session` table. Only that shape gets a private database under the
//! app data directory.

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

/// Share the CLI database, or point OpenCode at Termul's file when the CLI
/// database cannot start. An `OPENCODE_DB` already on the launch config is kept.
pub(crate) fn isolate(config: &mut AgentConfig) -> Result<(), String> {
    let Some(root) = app_data_dir() else {
        return Ok(());
    };
    let cli = cli_database_path(config);
    isolate_against(config, &root, cli.as_deref())
}

/// `cli_database` is the file OpenCode opens when `OPENCODE_DB` is unset.
/// `None` means that path could not be resolved, so the private file is used.
pub(crate) fn isolate_against(
    config: &mut AgentConfig,
    data_dir: &Path,
    cli_database: Option<&Path>,
) -> Result<(), String> {
    if !is_opencode(config) || config.env.contains_key(DB_ENV) {
        return Ok(());
    }
    if let Some(cli) = cli_database {
        match classify_cli_database(cli) {
            CliDatabase::Usable => {
                log::info!("[acp] opencode using the CLI database at {}", cli.display());
                return Ok(());
            }
            CliDatabase::Unreadable(error) => log::info!(
                "[acp] opencode CLI database at {} could not be read ({error}); using a private database",
                cli.display()
            ),
            CliDatabase::MissingSessionTable => log::info!(
                "[acp] opencode CLI database at {} has tables but no session table; using a private database",
                cli.display()
            ),
        }
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

/// Release OpenCode (`latest`, `beta`, `prod`) stores the database here.
/// `$XDG_DATA_HOME` wins over `$HOME/.local/share`, matching `xdg-basedir`.
fn cli_database_path(config: &AgentConfig) -> Option<PathBuf> {
    let root = env_path(config, "XDG_DATA_HOME").or_else(|| {
        env_path(config, "HOME")
            .or_else(|| env_path(config, "USERPROFILE"))
            .map(|home| home.join(".local").join("share"))
    })?;
    Some(root.join("opencode").join("opencode.db"))
}

fn env_path(config: &AgentConfig, key: &str) -> Option<PathBuf> {
    config
        .env
        .get(key)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os(key).map(PathBuf::from))
        .filter(|path| !path.as_os_str().is_empty())
}

enum CliDatabase {
    /// Missing, empty, or already an OpenCode database.
    Usable,
    Unreadable(String),
    /// Tables exist, but none is `session`. OpenCode refuses to migrate this.
    MissingSessionTable,
}

/// Missing and empty databases are usable: OpenCode creates or migrates them.
/// A readable database with a `session` table is usable. Anything else is not,
/// including a file that is not sqlite, because opening it would abort startup.
fn classify_cli_database(path: &Path) -> CliDatabase {
    if !path.exists() {
        return CliDatabase::Usable;
    }
    let connection = match rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(connection) => connection,
        Err(error) => return CliDatabase::Unreadable(error.to_string()),
    };
    let mut statement = match connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    {
        Ok(statement) => statement,
        Err(error) => return CliDatabase::Unreadable(error.to_string()),
    };
    let names = match statement.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(error) => return CliDatabase::Unreadable(error.to_string()),
    };
    let mut tables = Vec::new();
    for name in names {
        match name {
            Ok(name) => tables.push(name),
            Err(error) => return CliDatabase::Unreadable(error.to_string()),
        }
    }
    if tables.is_empty() || tables.iter().any(|name| name == "session") {
        CliDatabase::Usable
    } else {
        CliDatabase::MissingSessionTable
    }
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
