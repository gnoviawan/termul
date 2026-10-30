//! Known agents: the launch config of every agent a client has spawned,
//! keyed by `config_id` (fallback `name`), so the engine can start an agent
//! node without a renderer. Wire views expose only `{ agent_id, name }`;
//! `command`, `args` and `env` never leave the host.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::acp::atomic_file;
use crate::acp::config::AgentConfig;

pub const FILE_NAME: &str = "automation-agents.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownAgent {
    pub agent_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
struct RegistryFile {
    schema_version: u32,
    agents: BTreeMap<String, AgentConfig>,
}

/// The id an automation's agent node names for `config`.
pub fn agent_key(config: &AgentConfig) -> String {
    match config.config_id.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => config.name.clone(),
    }
}

pub struct AgentRegistry {
    /// `None` keeps the registry in memory only (tests).
    path: Option<PathBuf>,
    agents: Mutex<BTreeMap<String, AgentConfig>>,
}

impl AgentRegistry {
    /// Loads `path`. A missing file is an empty registry; an unreadable one is
    /// copied aside and the registry starts empty, so a corrupt file never
    /// blocks boot.
    pub fn open(path: PathBuf) -> Self {
        let agents = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<RegistryFile>(&bytes) {
                Ok(file) => file.agents,
                Err(error) => {
                    let backup = atomic_file::backup_corrupt(&path, &bytes);
                    log::warn!(
                        "[Automation] known-agents file is corrupt ({error}); starting empty (backup: {})",
                        backup.is_ok()
                    );
                    BTreeMap::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                log::warn!("[Automation] known-agents file unreadable: {error}");
                BTreeMap::new()
            }
        };
        log::info!("[Automation] known agents loaded: {}", agents.len());
        Self {
            path: Some(path),
            agents: Mutex::new(agents),
        }
    }

    pub fn in_memory() -> Self {
        Self {
            path: None,
            agents: Mutex::new(BTreeMap::new()),
        }
    }

    /// Remembers the latest launch config for its agent id. Writes only when
    /// the config changed, so a respawn of the same agent costs no IO.
    pub fn record(&self, config: &AgentConfig) {
        let key = agent_key(config);
        let mut agents = self.agents.lock();
        let unchanged = agents.get(&key).is_some_and(|known| {
            serde_json::to_value(known).ok() == serde_json::to_value(config).ok()
        });
        if unchanged {
            return;
        }
        agents.insert(key.clone(), config.clone());
        let Some(path) = &self.path else {
            return;
        };
        let file = RegistryFile {
            schema_version: SCHEMA_VERSION,
            agents: agents.clone(),
        };
        let written = serde_json::to_vec_pretty(&file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| atomic_file::replace_private(path, &bytes));
        match written {
            Ok(()) => log::info!("[Automation] recorded known agent {key:?}"),
            Err(error) => log::warn!("[Automation] could not save known agent {key:?}: {error}"),
        }
    }

    pub fn resolve(&self, agent_id: &str) -> Option<AgentConfig> {
        self.agents.lock().get(agent_id).cloned()
    }

    pub fn contains(&self, agent_id: &str) -> bool {
        self.agents.lock().contains_key(agent_id)
    }

    pub fn list(&self) -> Vec<KnownAgent> {
        self.agents
            .lock()
            .iter()
            .map(|(agent_id, config)| KnownAgent {
                agent_id: agent_id.clone(),
                name: config.name.clone(),
            })
            .collect()
    }
}
