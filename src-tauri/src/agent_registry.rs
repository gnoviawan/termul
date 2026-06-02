//! ADR-004.6: ACP Registry identity & discovery (opt-in, read-only).
//!
//! This module fetches the public ACP Registry index for AGENT IDENTITY ONLY
//! (id, name, description, website, icon). It is deliberately NOT used to derive
//! the terminal-native launch command — the registry's `distribution` field is
//! the ACP-server invocation (JSON-RPC over stdio), which would dump raw
//! JSON-RPC into a terminal. The app-owned launch table (renderer
//! `agent-registry.ts`) is authoritative for the TUI route.
//!
//! Security posture (ADR-004.6 §3): the default experience is fully offline
//! (built-in agents ship bundled icons in the renderer). This fetch happens only
//! on explicit user action ("Browse agents" / add custom agent), runs from the
//! Rust side (never the webview), caches results on disk, and is a plain read-only
//! GET of public JSON. It never transmits project data outbound.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_FILE: &str = "acp-registry-cache.json";
const FETCH_TIMEOUT_SECS: u64 = 15;

/// A single agent identity entry distilled from the ACP Registry. Only the
/// identity fields are surfaced — `distribution` is intentionally omitted so it
/// can never be mistaken for a TUI launch command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// Remote CDN SVG URL (16x16 monochrome `currentColor` per the registry spec).
    #[serde(default)]
    pub icon: Option<String>,
}

/// Result of a registry catalog request: the entries plus where they came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryCatalog {
    pub entries: Vec<AcpRegistryEntry>,
    /// 'network' when freshly fetched, 'cache' when served from disk, 'empty'
    /// when neither is available (caller falls back to bundled identities).
    pub source: String,
    /// ISO-8601 timestamp of when this catalog was fetched/cached, if known.
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
    description: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCatalog {
    entries: Vec<AcpRegistryEntry>,
    fetched_at: String,
}

fn parse_registry(body: &str) -> Result<Vec<AcpRegistryEntry>, String> {
    let raw: RawRegistry =
        serde_json::from_str(body).map_err(|e| format!("Failed to parse ACP registry: {}", e))?;

    let entries = raw
        .agents
        .into_iter()
        .map(|a| {
            let name = a.name.unwrap_or_else(|| a.id.clone());
            AcpRegistryEntry {
                id: a.id,
                name,
                description: a.description,
                website: a.website,
                icon: a.icon,
            }
        })
        .collect();

    Ok(entries)
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {}", e))?;
    Ok(dir.join(CACHE_FILE))
}

fn read_cache(app: &AppHandle) -> Option<CachedCatalog> {
    let path = cache_path(app).ok()?;
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<CachedCatalog>(&contents).ok()
}

fn write_cache(app: &AppHandle, entries: &[AcpRegistryEntry], fetched_at: &str) {
    let Ok(path) = cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cached = CachedCatalog {
        entries: entries.to_vec(),
        fetched_at: fetched_at.to_string(),
    };
    if let Ok(serialized) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, serialized);
    }
}

/// Fetch the ACP Registry catalog (identity/discovery only).
///
/// - `force_refresh = false`: serve the on-disk cache if present, else fetch.
/// - `force_refresh = true`: always attempt a network fetch, updating the cache.
///
/// On network failure, falls back to the cache when available; otherwise returns
/// an empty catalog (`source = "empty"`) so the renderer uses bundled identities.
/// Never errors hard for a transient network problem — discovery is best-effort.
pub async fn fetch_acp_registry(
    app: &AppHandle,
    force_refresh: bool,
) -> Result<AcpRegistryCatalog, String> {
    if !force_refresh {
        if let Some(cached) = read_cache(app) {
            return Ok(AcpRegistryCatalog {
                entries: cached.entries,
                source: "cache".to_string(),
                fetched_at: Some(cached.fetched_at),
            });
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let fetch_result: Result<Vec<AcpRegistryEntry>, String> = async {
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

        parse_registry(&body)
    }
    .await;

    match fetch_result {
        Ok(entries) => {
            let fetched_at = chrono::Utc::now().to_rfc3339();
            write_cache(app, &entries, &fetched_at);
            Ok(AcpRegistryCatalog {
                entries,
                source: "network".to_string(),
                fetched_at: Some(fetched_at),
            })
        }
        Err(network_err) => {
            // Network failed — degrade gracefully to cache, then to empty.
            if let Some(cached) = read_cache(app) {
                log::warn!(
                    "ACP registry fetch failed ({}); serving cached catalog",
                    network_err
                );
                return Ok(AcpRegistryCatalog {
                    entries: cached.entries,
                    source: "cache".to_string(),
                    fetched_at: Some(cached.fetched_at),
                });
            }
            log::warn!(
                "ACP registry fetch failed ({}); no cache available",
                network_err
            );
            Ok(AcpRegistryCatalog {
                entries: Vec::new(),
                source: "empty".to_string(),
                fetched_at: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_registry() {
        let body = r#"{
            "agents": [
                {
                    "id": "claude-acp",
                    "name": "Claude Code",
                    "description": "Anthropic's agent",
                    "website": "https://claude.com",
                    "icon": "https://cdn/icon.svg",
                    "distribution": { "binary": { "cmd": "claude-agent-acp", "args": [] } }
                }
            ]
        }"#;
        let entries = parse_registry(body).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "claude-acp");
        assert_eq!(entries[0].name, "Claude Code");
        assert_eq!(entries[0].icon.as_deref(), Some("https://cdn/icon.svg"));
    }

    #[test]
    fn missing_name_falls_back_to_id() {
        let body = r#"{ "agents": [ { "id": "mystery" } ] }"#;
        let entries = parse_registry(body).unwrap();
        assert_eq!(entries[0].name, "mystery");
    }

    #[test]
    fn ignores_unknown_fields_including_distribution() {
        // The parser distills identity only; `distribution` (the ACP invocation)
        // must never leak into the returned entry shape.
        let body = r#"{ "agents": [ { "id": "x", "distribution": { "npx": { "cmd": "x-acp" } }, "extra": 1 } ] }"#;
        let entries = parse_registry(body).unwrap();
        assert_eq!(entries.len(), 1);
        let json = serde_json::to_string(&entries[0]).unwrap();
        assert!(!json.contains("distribution"));
        assert!(!json.contains("x-acp"));
    }

    #[test]
    fn empty_agents_list_is_ok() {
        let body = r#"{ "agents": [] }"#;
        assert_eq!(parse_registry(body).unwrap().len(), 0);
    }

    #[test]
    fn malformed_json_errors() {
        assert!(parse_registry("not json").is_err());
    }
}
