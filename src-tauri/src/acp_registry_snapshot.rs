//! Opt-in fetch of the full ACP registry snapshot for Agent Chat updates.
//!
//! Unlike `agent_registry` (identity-only for the terminal route), this module
//! returns launch metadata (`distribution`) so the renderer can refresh its
//! offline catalog on explicit user action.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_FILE: &str = "acp-registry-snapshot-cache.json";
const FETCH_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySnapshotAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub distribution: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySnapshot {
    pub agents: Vec<AcpRegistrySnapshotAgent>,
    pub source: String,
    #[serde(default)]
    pub fetched_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawRegistry {
    #[serde(default)]
    agents: Vec<RawAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgent {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    distribution: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedSnapshot {
    agents: Vec<AcpRegistrySnapshotAgent>,
    fetched_at: String,
}

pub fn is_safe_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn sanitize_distribution(value: &serde_json::Value) -> Option<serde_json::Value> {
    value.as_object().cloned().map(serde_json::Value::Object)
}

fn parse_snapshot(body: &str) -> Result<Vec<AcpRegistrySnapshotAgent>, String> {
    let raw: RawRegistry =
        serde_json::from_str(body).map_err(|e| format!("Failed to parse ACP registry: {}", e))?;

    let mut agents = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for agent in raw.agents {
        if !is_safe_agent_id(&agent.id) || seen.contains(&agent.id) {
            continue;
        }
        let Some(distribution) = agent.distribution.as_ref().and_then(sanitize_distribution) else {
            continue;
        };
        seen.insert(agent.id.clone());
        agents.push(AcpRegistrySnapshotAgent {
            id: agent.id.clone(),
            name: agent
                .name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| agent.id.clone()),
            version: agent.version.unwrap_or_default(),
            description: agent.description.unwrap_or_default(),
            distribution,
        });
    }
    Ok(agents)
}

fn read_cache_at(path: &std::path::Path) -> Option<CachedSnapshot> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<CachedSnapshot>(&contents).ok()
}

fn write_cache_at(path: &std::path::Path, agents: &[AcpRegistrySnapshotAgent], fetched_at: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cached = CachedSnapshot {
        agents: agents.to_vec(),
        fetched_at: fetched_at.to_string(),
    };
    if let Ok(serialized) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, serialized);
    }
}

/// Core fetch+parse+cache logic parameterized by an explicit cache file path.
/// Both the desktop `AppHandle`-based entry point and the standalone
/// `AcpCatalogService` path delegate here so the fetch logic is NOT duplicated
/// (CAP-6 / Story 8 reuses this for the catalog's CDN augmentation).
pub async fn fetch_acp_registry_snapshot_with_cache_path(
    cache_path: &std::path::Path,
    force_refresh: bool,
) -> Result<AcpRegistrySnapshot, String> {
    if !force_refresh {
        if let Some(cached) = read_cache_at(cache_path) {
            return Ok(AcpRegistrySnapshot {
                agents: cached.agents,
                source: "cache".to_string(),
                fetched_at: Some(cached.fetched_at),
            });
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let fetch_result: Result<Vec<AcpRegistrySnapshotAgent>, String> = async {
        let response = client
            .get(REGISTRY_URL)
            .send()
            .await
            .map_err(|e| format!("ACP registry request failed: {}", e))?;
        if !response.status().is_success() {
            return Err(format!("ACP registry returned HTTP {}", response.status()));
        }
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read ACP registry body: {}", e))?;
        parse_snapshot(&body)
    }
    .await;

    match fetch_result {
        Ok(agents) => {
            let fetched_at = chrono::Utc::now().to_rfc3339();
            write_cache_at(cache_path, &agents, &fetched_at);
            Ok(AcpRegistrySnapshot {
                agents,
                source: "network".to_string(),
                fetched_at: Some(fetched_at),
            })
        }
        Err(network_err) => {
            if let Some(cached) = read_cache_at(cache_path) {
                log::warn!(
                    "ACP registry snapshot fetch failed ({}); serving cached snapshot",
                    network_err
                );
                return Ok(AcpRegistrySnapshot {
                    agents: cached.agents,
                    source: "cache".to_string(),
                    fetched_at: Some(cached.fetched_at),
                });
            }
            Err(network_err)
        }
    }
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {}", e))?;
    Ok(dir.join(CACHE_FILE))
}

pub async fn fetch_acp_registry_snapshot(
    app: &AppHandle,
    force_refresh: bool,
) -> Result<AcpRegistrySnapshot, String> {
    let path = cache_path(app)?;
    fetch_acp_registry_snapshot_with_cache_path(&path, force_refresh).await
}

#[tauri::command]
pub async fn acp_fetch_registry_snapshot(
    app: AppHandle,
    force_refresh: Option<bool>,
) -> Result<AcpRegistrySnapshot, String> {
    fetch_acp_registry_snapshot(&app, force_refresh.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agents_with_distribution() {
        let body = r#"{
            "agents": [
                {
                    "id": "claude-acp",
                    "name": "Claude Agent",
                    "version": "0.52.0",
                    "description": "Anthropic agent",
                    "distribution": { "npx": { "package": "@agentclientprotocol/claude-agent-acp@0.52.0" } }
                }
            ]
        }"#;
        let agents = parse_snapshot(body).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "claude-acp");
        assert!(agents[0].distribution.get("npx").is_some());
    }

    #[test]
    fn skips_agents_without_distribution() {
        let body = r#"{ "agents": [ { "id": "broken" } ] }"#;
        assert!(parse_snapshot(body).unwrap().is_empty());
    }
}
