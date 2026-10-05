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
