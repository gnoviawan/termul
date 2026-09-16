//! Opt-in fetch of the full ACP registry snapshot for Agent Chat updates.
//!
//! Unlike `agent_registry` (identity-only for the terminal route), this module
//! returns launch metadata (`distribution`) so the renderer can refresh its
//! offline catalog on explicit user action.

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const FETCH_TIMEOUT_SECS: u64 = 15;
/// Snapshot cache TTL — 24h. Within the TTL the cache is served with zero
/// network; past it the CDN is refetched and a failure falls back to the
/// stale cache. Registry metadata only (npx pins), never binaries, so 24h of
/// staleness is an acceptable risk profile.
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Maximum tolerated forward clock skew on a cached `fetched_at`. A timestamp
/// further in the future than this (clock set forward then back, or a corrupt
/// write) would otherwise pin the cache as "fresh" forever — treat it as
/// expired instead.
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySnapshotAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub distribution: serde_json::Value,
}

/// How a snapshot fetch attempt concluded. Rust-internal (never serialized —
/// no wire-shape change); callers use it to drive retry gating, which the
/// `Result` alone cannot express (a network failure with a stale-cache
/// fallback is `Ok`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotFetchOutcome {
    /// Fetched from the CDN; the cache rewrite was attempted.
    NetworkFresh,
    /// Fresh cache served, zero network.
    FreshCache,
    /// Network failed; the stale cache was served.
    StaleAfterFailure,
}

/// The result of a snapshot resolution: the snapshot plus the fetch outcome
/// and whether on-disk cache persistence is confirmed. `persisted` is `true`
/// for cache-served outcomes (the cache demonstrably exists — it was just
/// read); for `NetworkFresh` it is the result of the cache write.
#[derive(Debug)]
pub struct ResolvedSnapshot {
    pub snapshot: AcpRegistrySnapshot,
    pub outcome: SnapshotFetchOutcome,
    pub persisted: bool,
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
    // Reject `.` and `..` outright: the per-character allow-list admits them
    // (every char is `.`), but they denote the current/parent directory and
    // would escape the install root via `root.join(&agent.id)` (CWE-22).
    !id.is_empty()
        && !matches!(id, "." | "..")
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

fn write_cache_at(
    path: &std::path::Path,
    agents: &[AcpRegistrySnapshotAgent],
    fetched_at: &str,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let cached = CachedSnapshot {
        agents: agents.to_vec(),
        fetched_at: fetched_at.to_string(),
    };
    // Crash-consistent write: the cache is shared between the manual-refresh
    // command and the catalog augmentation, so a torn write must never be
    // readable as a missing/corrupt cache (an offline host would lose its
    // stale fallback).
    let serialized = serde_json::to_vec(&cached).map_err(std::io::Error::other)?;
    crate::acp::atomic_file::replace(path, &serialized)
}

/// Read the on-disk snapshot cache without any network access, regardless of
/// TTL freshness. Used by `AcpCatalogService`'s retry gate to serve the stale
/// cache directly while a recent fetch failure is still within the retry
/// interval. `None` when the file is missing or unparseable.
pub(crate) fn read_cached_snapshot(
    cache_path: &std::path::Path,
) -> Option<AcpRegistrySnapshot> {
    read_cache_at(cache_path).map(|cached| AcpRegistrySnapshot {
        agents: cached.agents,
        source: "cache".to_string(),
        fetched_at: Some(cached.fetched_at),
    })
}

/// Whether a cached snapshot's `fetched_at` timestamp is within the TTL.
/// An unparseable timestamp is treated as expired (attempt network, fall
/// back to the stale cache on failure). A future timestamp (clock skew) is
/// treated as fresh only within [`MAX_CLOCK_SKEW`] — further out would pin
/// the cache forever, so it counts as expired.
fn cache_is_fresh(fetched_at: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Ok(fetched) = chrono::DateTime::parse_from_rfc3339(fetched_at) else {
        return false;
    };
    let age = now.signed_duration_since(fetched.with_timezone(&chrono::Utc));
    let skewed = -age;
    age < chrono::Duration::from_std(CACHE_TTL).unwrap_or(chrono::Duration::MAX)
        && skewed
            <= chrono::Duration::from_std(MAX_CLOCK_SKEW).unwrap_or(chrono::Duration::MAX)
}

/// Network fetch of the live CDN registry (no cache interaction). The URL is
/// a fixed https-only constant — no caller-supplied or persisted input.
async fn fetch_registry_agents() -> Result<Vec<AcpRegistrySnapshotAgent>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

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

/// Cache-policy core, parameterized by the network fetch so the I/O matrix
/// (fresh / expired / offline / force-refresh) is unit-testable without
/// touching the network:
/// - `force_refresh=false` + fresh cache → serve cache, zero network.
/// - `force_refresh=false` + expired/missing cache → fetch; on failure serve
///   the stale cache (warn log) or, with no cache at all, return the error.
/// - `force_refresh=true` → bypass the TTL and fetch; on failure still serve
///   any cache (manual refresh surfaces success-with-stale as before).
async fn resolve_snapshot<F, Fut>(
    cache_path: &std::path::Path,
    force_refresh: bool,
    fetch: F,
) -> Result<ResolvedSnapshot, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Vec<AcpRegistrySnapshotAgent>, String>>,
{
    if !force_refresh {
        if let Some(cached) = read_cache_at(cache_path) {
            if cache_is_fresh(&cached.fetched_at, chrono::Utc::now()) {
                return Ok(ResolvedSnapshot {
                    snapshot: AcpRegistrySnapshot {
                        agents: cached.agents,
                        source: "cache".to_string(),
                        fetched_at: Some(cached.fetched_at),
                    },
                    outcome: SnapshotFetchOutcome::FreshCache,
                    persisted: true,
                });
            }
        }
    }

    match fetch().await {
        Ok(agents) => {
            let fetched_at = chrono::Utc::now().to_rfc3339();
            let persisted = match write_cache_at(cache_path, &agents, &fetched_at) {
                Ok(()) => true,
                Err(error) => {
                    // Persistence unconfirmed: the caller still gets the fresh
                    // snapshot, but must NOT invalidate downstream caches
                    // against an unrewritten on-disk cache.
                    log::warn!(
                        "ACP registry snapshot cache write failed (persistence unconfirmed): {}",
                        error
                    );
                    false
                }
            };
            Ok(ResolvedSnapshot {
                snapshot: AcpRegistrySnapshot {
                    agents,
                    source: "network".to_string(),
                    fetched_at: Some(fetched_at),
                },
                outcome: SnapshotFetchOutcome::NetworkFresh,
                persisted,
            })
        }
        Err(network_err) => {
            if let Some(cached) = read_cache_at(cache_path) {
                log::warn!(
                    "ACP registry snapshot fetch failed ({}); serving cached snapshot",
                    network_err
                );
                return Ok(ResolvedSnapshot {
                    snapshot: AcpRegistrySnapshot {
                        agents: cached.agents,
                        source: "cache".to_string(),
                        fetched_at: Some(cached.fetched_at),
                    },
                    outcome: SnapshotFetchOutcome::StaleAfterFailure,
                    persisted: true,
                });
            }
            Err(network_err)
        }
    }
}

/// Core fetch+parse+cache logic parameterized by an explicit cache file path.
/// Both the desktop Tauri command and the `AcpCatalogService` CDN augmentation
/// delegate here so the fetch logic is NOT duplicated (CAP-6 / Story 8 reuses
/// this for the catalog's CDN augmentation). TTL semantics: a cache younger
/// than [`CACHE_TTL`] is served with zero network unless `force_refresh`.
/// Returns the snapshot plus the fetch outcome + cache-persistence flag so
/// callers can drive retry gating and cache invalidation on the REAL network
/// outcome (the `Result` alone conflates network failure with its stale-cache
/// fallback).
pub async fn fetch_acp_registry_snapshot_with_cache_path(
    cache_path: &std::path::Path,
    force_refresh: bool,
) -> Result<ResolvedSnapshot, String> {
    resolve_snapshot(cache_path, force_refresh, fetch_registry_agents).await
}

/// Desktop "Check for updates" / "Apply remote registry" entry point. Uses
/// the catalog root's snapshot cache (`<app_data_dir>/acp-catalog/
/// acp-registry-snapshot-cache.json`) — the SAME cache the catalog
/// augmentation serves — so a manual refresh flows into the next
/// `list_catalog` resolution (single shared cache, no dual-cache split).
#[tauri::command]
pub async fn acp_fetch_registry_snapshot(
    store: tauri::State<'_, crate::commands::HostAcpCatalogStore>,
    force_refresh: Option<bool>,
) -> Result<AcpRegistrySnapshot, String> {
    let Some(service) = store.store().map(std::sync::Arc::clone) else {
        log::warn!("[acp-catalog] snapshot fetch unavailable (no host store)");
        return Err("acp catalog store is unavailable".to_string());
    };
    service
        .fetch_registry_snapshot(force_refresh.unwrap_or(false))
        .await
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

    #[test]
    fn is_safe_agent_id_rejects_dot_and_dotdot() {
        // `.` / `..` denote the current/parent directory and would escape the
        // install root via `root.join(&agent.id)` (CWE-22) — reject outright.
        assert!(!is_safe_agent_id("."));
        assert!(!is_safe_agent_id(".."));
        // Dotted ids that are NOT bare `.`/`..` remain valid.
        assert!(is_safe_agent_id("com.example.agent"));
        assert!(is_safe_agent_id("claude-acp"));
    }

    // ---- Cache TTL I/O matrix (injected fetcher — no network) ----

    fn temp_cache_path(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "termul-acp-snapshot-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("acp-registry-snapshot-cache.json")
    }

    fn sample_agent(id: &str) -> AcpRegistrySnapshotAgent {
        AcpRegistrySnapshotAgent {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            distribution: serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
        }
    }

    fn fresh_timestamp() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    fn stale_timestamp() -> String {
        (chrono::Utc::now() - chrono::Duration::hours(48)).to_rfc3339()
    }

    #[test]
    fn cache_is_fresh_within_ttl() {
        let now = chrono::Utc::now();
        assert!(cache_is_fresh(&now.to_rfc3339(), now));
        assert!(cache_is_fresh(
            &(now - chrono::Duration::hours(23)).to_rfc3339(),
            now
        ));
    }

    #[test]
    fn cache_is_stale_beyond_ttl() {
        let now = chrono::Utc::now();
        assert!(!cache_is_fresh(
            &(now - chrono::Duration::hours(25)).to_rfc3339(),
            now
        ));
    }

    #[test]
    fn cache_is_fresh_treats_unparseable_as_expired_and_future_as_fresh() {
        let now = chrono::Utc::now();
        assert!(!cache_is_fresh("not-a-date", now));
        // Clock skew within tolerance: a slightly-future timestamp is fresh.
        assert!(cache_is_fresh(
            &(now + chrono::Duration::minutes(30)).to_rfc3339(),
            now
        ));
        assert!(cache_is_fresh(
            &(now + chrono::Duration::hours(1)).to_rfc3339(),
            now
        ));
    }

    #[test]
    fn cache_is_fresh_treats_far_future_timestamp_as_expired() {
        // A clock set forward then back (or a corrupt write) must not pin the
        // cache as fresh forever: beyond MAX_CLOCK_SKEW it counts as expired.
        let now = chrono::Utc::now();
        assert!(!cache_is_fresh(
            &(now + chrono::Duration::hours(2)).to_rfc3339(),
            now
        ));
        assert!(!cache_is_fresh(
            &(now + chrono::Duration::days(7)).to_rfc3339(),
            now
        ));
    }

    #[tokio::test]
    async fn fresh_cache_served_without_network() {
        let path = temp_cache_path("fresh");
        write_cache_at(&path, &[sample_agent("cached-agent")], &fresh_timestamp()).unwrap();
        let resolved = resolve_snapshot(&path, false, || async {
            Err("network must not be called for a fresh cache".to_string())
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::FreshCache);
        assert!(resolved.persisted);
        assert_eq!(resolved.snapshot.source, "cache");
        assert_eq!(resolved.snapshot.agents.len(), 1);
        assert_eq!(resolved.snapshot.agents[0].id, "cached-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn expired_cache_refetches_and_rewrites_cache() {
        let path = temp_cache_path("expired-ok");
        write_cache_at(&path, &[sample_agent("stale-agent")], &stale_timestamp()).unwrap();
        let resolved = resolve_snapshot(&path, false, || async {
            Ok(vec![sample_agent("new-agent")])
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::NetworkFresh);
        assert!(resolved.persisted);
        assert_eq!(resolved.snapshot.source, "network");
        assert_eq!(resolved.snapshot.agents[0].id, "new-agent");
        // The cache file is rewritten with the fresh snapshot.
        let cached = read_cache_at(&path).unwrap();
        assert_eq!(cached.agents[0].id, "new-agent");
        assert!(cache_is_fresh(&cached.fetched_at, chrono::Utc::now()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn network_fetch_with_unwritable_cache_returns_ok_persisted_false() {
        // A directory at the cache path makes the atomic write fail. The
        // caller still gets the fresh snapshot, but `persisted=false` so it
        // must NOT invalidate downstream caches against the unrewritten disk
        // cache.
        let path = temp_cache_path("unwritable");
        std::fs::create_dir_all(&path).unwrap();
        let resolved = resolve_snapshot(&path, false, || async {
            Ok(vec![sample_agent("new-agent")])
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::NetworkFresh);
        assert!(!resolved.persisted);
        assert_eq!(resolved.snapshot.source, "network");
        assert_eq!(resolved.snapshot.agents[0].id, "new-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn expired_cache_offline_serves_stale_cache() {
        let path = temp_cache_path("expired-offline");
        write_cache_at(&path, &[sample_agent("stale-agent")], &stale_timestamp()).unwrap();
        let resolved = resolve_snapshot(&path, false, || async {
            Err("simulated network failure".to_string())
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::StaleAfterFailure);
        assert!(resolved.persisted);
        assert_eq!(resolved.snapshot.source, "cache");
        assert_eq!(resolved.snapshot.agents[0].id, "stale-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn no_cache_offline_returns_error() {
        let path = temp_cache_path("no-cache-offline");
        let result = resolve_snapshot(&path, false, || async {
            Err("simulated network failure".to_string())
        })
        .await;
        assert_eq!(result.unwrap_err(), "simulated network failure");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn force_refresh_fetch_failure_serves_stale_cache() {
        // Manual refresh + network failure + existing cache → success-with-
        // stale (source "cache"), matching the pre-TTL UI behavior.
        let path = temp_cache_path("force-failure-stale");
        write_cache_at(&path, &[sample_agent("stale-agent")], &fresh_timestamp()).unwrap();
        let resolved = resolve_snapshot(&path, true, || async {
            Err("simulated network failure".to_string())
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::StaleAfterFailure);
        assert_eq!(resolved.snapshot.source, "cache");
        assert_eq!(resolved.snapshot.agents[0].id, "stale-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn force_refresh_bypasses_fresh_cache() {
        let path = temp_cache_path("force-refresh");
        write_cache_at(&path, &[sample_agent("cached-agent")], &fresh_timestamp()).unwrap();
        let resolved = resolve_snapshot(&path, true, || async {
            Ok(vec![sample_agent("forced-agent")])
        })
        .await
        .unwrap();
        assert_eq!(resolved.outcome, SnapshotFetchOutcome::NetworkFresh);
        assert_eq!(resolved.snapshot.source, "network");
        assert_eq!(resolved.snapshot.agents[0].id, "forced-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn malformed_fetched_at_treated_as_expired() {
        let path = temp_cache_path("malformed-ts");
        let raw = serde_json::json!({
            "agents": [sample_agent("stale-agent")],
            "fetchedAt": "not-a-date"
        });
        std::fs::write(&path, serde_json::to_string(&raw).unwrap()).unwrap();
        let resolved = resolve_snapshot(&path, false, || async {
            Ok(vec![sample_agent("refetched-agent")])
        })
        .await
        .unwrap();
        assert_eq!(resolved.snapshot.source, "network");
        assert_eq!(resolved.snapshot.agents[0].id, "refetched-agent");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
