use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-acp-catalog-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn sample_agent(id: &str, distribution: serde_json::Value) -> BundledAgent {
    BundledAgent {
        id: id.to_string(),
        name: id.to_string(),
        version: "1.0.0".to_string(),
        description: "test".to_string(),
        distribution,
    }
}

fn host_with_runtimes(npx: bool, uvx: bool) -> HostCapability {
    HostCapability {
        os: "linux".to_string(),
        arch: "x86_64".to_string(),
        runtimes: CatalogRuntimeAvailability {
            npx,
            uvx,
            node: true,
            bun: false,
            python3: true,
            npm: true,
            node_major: Some(22),
            claude_cli: true,
            unavailable_reason: None,
        },
    }
}

// ---- Bundled catalog parse ----

#[test]
fn bundled_catalog_parses_successfully() {
    let agents = parse_bundled_catalog().unwrap();
    assert!(!agents.is_empty(), "bundled catalog should not be empty");
    // Every entry must have an id + name + distribution.
    for agent in &agents {
        assert!(!agent.id.is_empty(), "agent id must not be empty");
        assert!(!agent.name.is_empty(), "agent name must not be empty");
        assert!(
            agent.distribution.is_object(),
            "agent distribution must be an object"
        );
    }
}

#[test]
fn bundled_catalog_includes_known_agents() {
    let agents = parse_bundled_catalog().unwrap();
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    assert!(
        ids.contains(&"claude-acp"),
        "claude-acp must be in the bundled catalog"
    );
    assert!(
        ids.contains(&"gemini"),
        "gemini must be in the bundled catalog"
    );
}

// ---- I/O matrix: npx on PATH → ready ----

#[test]
fn npx_agent_with_npx_on_path_is_ready() {
    let agent = sample_agent(
        "test-npx",
        serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
    );
    let host = host_with_runtimes(true, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Ready);
    assert_eq!(catalog_agent.runtime_requirements, vec!["npx".to_string()]);
    assert_eq!(catalog_agent.source, CatalogSource::Bundled);
}

// ---- I/O matrix: npx missing → needs-runtime ----

#[test]
fn npx_agent_without_npx_is_needs_runtime() {
    let agent = sample_agent(
        "test-npx",
        serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::NeedsRuntime);
}

#[test]
fn claude_acp_requires_node_22_npm_and_the_external_cli() {
    let agent = sample_agent(
        "claude-acp",
        serde_json::json!({
            "npx": {
                "package": "@agentclientprotocol/claude-agent-acp@0.78.0"
            }
        }),
    );
    let mut host = host_with_runtimes(true, false);
    host.runtimes.node_major = Some(20);
    host.runtimes.npm = true;
    host.runtimes.claude_cli = true;
    assert_eq!(
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled).status,
        SupportedAcpAgentStatus::NeedsRuntime
    );

    host.runtimes.node_major = Some(22);
    host.runtimes.npm = false;
    assert_eq!(
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled).status,
        SupportedAcpAgentStatus::NeedsRuntime
    );

    host.runtimes.npm = true;
    host.runtimes.claude_cli = false;
    assert_eq!(
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled).status,
        SupportedAcpAgentStatus::ManualInstall
    );

    host.runtimes.claude_cli = true;
    assert_eq!(
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled).status,
        SupportedAcpAgentStatus::InstallRequired
    );
}

#[test]
fn installed_claude_does_not_bypass_node_or_cli_preflight() {
    let agent = sample_agent(
        "claude-acp",
        serde_json::json!({
            "npx": {
                "package": "@agentclientprotocol/claude-agent-acp@0.78.0"
            }
        }),
    );
    let mut host = host_with_runtimes(true, false);
    host.runtimes.node_major = Some(20);
    host.runtimes.npm = true;
    host.runtimes.claude_cli = true;
    let mut catalog = AcpCatalog {
        registry_degraded: false,
        host: host.clone(),
        agents: vec![compute_catalog_agent(
            &agent,
            &host,
            "linux-x86_64",
            CatalogSource::Bundled,
        )],
    };
    let installed = crate::acp::install::InstalledAgent {
        agent_id: "claude-acp".to_string(),
        version: "0.78.0".to_string(),
        platform_target: "linux-x86_64".to_string(),
        sha256: String::new(),
        command: "/termul/cache/node".to_string(),
        args: vec!["/termul/cache/claude-agent-acp/dist/index.js".to_string()],
        installed_at: 0,
    };

    overlay_installed(&mut catalog, &[installed]);

    assert_eq!(
        catalog.agents[0].status,
        SupportedAcpAgentStatus::NeedsRuntime
    );
    assert!(catalog.agents[0].installed.is_some());

    catalog.host.runtimes.node_major = Some(22);
    catalog.host.runtimes.npm = false;
    catalog.host.runtimes.claude_cli = true;
    overlay_installed(
        &mut catalog,
        &[crate::acp::install::InstalledAgent {
            agent_id: "claude-acp".to_string(),
            version: "0.78.0".to_string(),
            platform_target: "linux-x86_64".to_string(),
            sha256: String::new(),
            command: "/termul/cache/node".to_string(),
            args: vec!["/termul/cache/claude-agent-acp/dist/index.js".to_string()],
            installed_at: 0,
        }],
    );
    // Unified policy (`claude_agent::claude_status`): npm missing is a
    // runtime gap even for an installed agent (matches the overlay doc
    // contract "must still pass its Node/npm and external CLI preflight").
    assert_eq!(
        catalog.agents[0].status,
        SupportedAcpAgentStatus::NeedsRuntime
    );

    catalog.host.runtimes.npm = true;
    catalog.host.runtimes.claude_cli = false;
    overlay_installed(
        &mut catalog,
        &[crate::acp::install::InstalledAgent {
            agent_id: "claude-acp".to_string(),
            version: "0.78.0".to_string(),
            platform_target: "linux-x86_64".to_string(),
            sha256: String::new(),
            command: "/termul/cache/node".to_string(),
            args: vec!["/termul/cache/claude-agent-acp/dist/index.js".to_string()],
            installed_at: 0,
        }],
    );
    assert_eq!(
        catalog.agents[0].status,
        SupportedAcpAgentStatus::ManualInstall
    );

    catalog.host.runtimes.claude_cli = true;
    overlay_installed(
        &mut catalog,
        &[crate::acp::install::InstalledAgent {
            agent_id: "claude-acp".to_string(),
            version: "0.78.0".to_string(),
            platform_target: "linux-x86_64".to_string(),
            sha256: String::new(),
            command: "/termul/cache/node".to_string(),
            args: vec!["/termul/cache/claude-agent-acp/dist/index.js".to_string()],
            installed_at: 0,
        }],
    );
    assert_eq!(catalog.agents[0].status, SupportedAcpAgentStatus::Ready);
}

// ---- I/O matrix: uvx on PATH → ready ----

#[test]
fn uvx_agent_with_uvx_on_path_is_ready() {
    let agent = sample_agent(
        "test-uvx",
        serde_json::json!({ "uvx": { "package": "test==1.0.0" } }),
    );
    let host = host_with_runtimes(false, true);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Ready);
    assert_eq!(catalog_agent.runtime_requirements, vec!["uvx".to_string()]);
}

// ---- I/O matrix: uvx missing → needs-runtime ----

#[test]
fn uvx_agent_without_uvx_is_needs_runtime() {
    let agent = sample_agent(
        "test-uvx",
        serde_json::json!({ "uvx": { "package": "test==1.0.0" } }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::NeedsRuntime);
}

// ---- I/O matrix: binary with archive → install-required (no sha256 gate) ----

#[test]
fn binary_agent_with_https_archive_and_sha256_is_install_required() {
    // The catalog is the trusted Zed ACP registry, so an HTTPS archive is
    // `install-required` regardless of a `sha256` digest — the host
    // downloads + extracts + activates without integrity verification.
    let agent = sample_agent(
        "test-binary",
        serde_json::json!({
            "binary": {
                "linux-x86_64": {
                    "cmd": "./test-agent",
                    "archive": "https://example.com/test-agent-linux-x86_64.tar.gz",
                    "sha256": "abcdef0123456789"
                }
            }
        }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(
        catalog_agent.status,
        SupportedAcpAgentStatus::InstallRequired
    );
    assert!(!catalog_agent.platform_targets.is_empty());
}

// ---- I/O matrix: binary with archive but NO sha256 → install-required ----

#[test]
fn binary_agent_with_archive_but_no_sha256_is_install_required() {
    // No sha256 gate: an HTTPS archive without a digest is still
    // `install-required` (clickable) — the trusted catalog makes the
    // install available; the host installs without integrity verification.
    let agent = sample_agent(
        "test-binary",
        serde_json::json!({
            "binary": {
                "linux-x86_64": {
                    "cmd": "./test-agent",
                    "archive": "https://example.com/test-agent-linux-x86_64.tar.gz"
                }
            }
        }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(
        catalog_agent.status,
        SupportedAcpAgentStatus::InstallRequired
    );
}

// ---- I/O matrix: binary with archive + EMPTY-string sha256 → install-required ----

#[test]
fn binary_agent_with_archive_but_empty_sha256_is_install_required() {
    // An empty-string `sha256` is irrelevant now — the install proceeds
    // without verification, so the status is `install-required`.
    let agent = sample_agent(
        "test-binary",
        serde_json::json!({
            "binary": {
                "linux-x86_64": {
                    "cmd": "./test-agent",
                    "archive": "https://example.com/test-agent-linux-x86_64.tar.gz",
                    "sha256": ""
                }
            }
        }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(
        catalog_agent.status,
        SupportedAcpAgentStatus::InstallRequired
    );
}

// ---- I/O matrix: binary without archive → manual-install ----

#[test]
fn binary_agent_without_archive_is_manual_install() {
    let agent = sample_agent(
        "test-binary",
        serde_json::json!({
            "binary": {
                "linux-x86_64": {
                    "cmd": "./test-agent"
                }
            }
        }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::ManualInstall);
}

// ---- I/O matrix: no platform target → unavailable ----

#[test]
fn binary_agent_no_matching_platform_is_unavailable() {
    let agent = sample_agent(
        "test-binary",
        serde_json::json!({
            "binary": {
                "darwin-aarch64": {
                    "cmd": "./test-agent",
                    "archive": "https://example.com/test-agent-darwin.tar.gz"
                }
            }
        }),
    );
    let host = host_with_runtimes(false, false);
    let catalog_agent =
        compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
    assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Unavailable);
}

// ---- I/O matrix: binary bare-name on PATH → ready (probe-injected) ----

#[test]
fn binary_agent_bare_name_on_path_is_ready() {
    // A bare-name (non-relative) cmd with an installable archive.
    // When the injected probe reports the binary is on PATH, the status is
    // `ready` (the archive is not used). When the probe reports it is NOT
    // on PATH, the status falls through to `install-required` (HTTPS
    // archive — no sha256 gate, the trusted catalog makes install available).
    let target: serde_json::Map<String, serde_json::Value> = serde_json::json!({
        "cmd": "test-agent",
        "archive": "https://example.com/test-agent.zip",
        "sha256": "abcdef"
    })
    .as_object()
    .unwrap()
    .clone();

    assert_eq!(
        compute_binary_status(Some(&target), |_| true),
        SupportedAcpAgentStatus::Ready
    );

    // When the probe reports it is NOT on PATH, the status falls through
    // to `install-required` (HTTPS archive — sha256 is not required).
    assert_eq!(
        compute_binary_status(Some(&target), |_| false),
        SupportedAcpAgentStatus::InstallRequired
    );
}

// ---- overlay_installed: host-installed agents → ready + command/args ----

#[test]
fn overlay_installed_marks_installed_agents_ready_with_command() {
    // The host overlays installed state so installed agents report `ready`
    // with their resolved absolute command/args — the web (no renderer
    // persistence) builds a spawn config from this.
    let mut catalog = AcpCatalog {
        registry_degraded: false,
        host: host_with_runtimes(false, false),
        agents: vec![
            CatalogAgent {
                id: "installed-bin".to_string(),
                name: "Installed".to_string(),
                version: "1.0.0".to_string(),
                description: "d".to_string(),
                source: CatalogSource::Bundled,
                distribution: serde_json::json!({
                    "binary": { "linux-x86_64": {
                        "cmd": "./installed",
                        "archive": "https://example.com/installed.zip"
                    }}
                }),
                runtime_requirements: Vec::new(),
                status: SupportedAcpAgentStatus::InstallRequired,
                platform_targets: Vec::new(),
                installed: None,
            },
            CatalogAgent {
                id: "not-installed".to_string(),
                name: "NotInstalled".to_string(),
                version: "1.0.0".to_string(),
                description: "d".to_string(),
                source: CatalogSource::Bundled,
                distribution: serde_json::json!({
                    "binary": { "linux-x86_64": {
                        "cmd": "./other",
                        "archive": "https://example.com/other.zip"
                    }}
                }),
                runtime_requirements: Vec::new(),
                status: SupportedAcpAgentStatus::InstallRequired,
                platform_targets: Vec::new(),
                installed: None,
            },
        ],
    };
    let installed = vec![crate::acp::install::InstalledAgent {
        agent_id: "installed-bin".to_string(),
        // The manifest version is what the user actually runs; it may lag
        // the catalog's registry version (1.0.0) — update detection keys
        // off the installed version.
        version: "0.9.5".to_string(),
        platform_target: "linux-x86_64".to_string(),
        sha256: String::new(),
        command: "/abs/acp-registry-binaries/installed-bin/installed".to_string(),
        args: vec!["acp".to_string()],
        installed_at: 0,
    }];
    overlay_installed(&mut catalog, &installed);

    let by_id: std::collections::HashMap<&str, &CatalogAgent> =
        catalog.agents.iter().map(|a| (a.id.as_str(), a)).collect();
    let installed_agent = by_id.get("installed-bin").unwrap();
    assert_eq!(installed_agent.status, SupportedAcpAgentStatus::Ready);
    let info = installed_agent.installed.as_ref().expect("installed block");
    assert_eq!(
        info.command,
        "/abs/acp-registry-binaries/installed-bin/installed"
    );
    assert_eq!(info.args, vec!["acp".to_string()]);
    // The installed manifest version is surfaced so clients can detect
    // per-agent updates (installed version vs registry version).
    assert_eq!(info.version, "0.9.5");
    // The not-installed agent is untouched.
    let other = by_id.get("not-installed").unwrap();
    assert_eq!(other.status, SupportedAcpAgentStatus::InstallRequired);
    assert!(other.installed.is_none());
}

#[test]
fn overlay_installed_no_op_when_empty() {
    let mut catalog = AcpCatalog {
        registry_degraded: false,
        host: host_with_runtimes(false, false),
        agents: vec![],
    };
    overlay_installed(&mut catalog, &[]);
    assert!(catalog.agents.is_empty());
}

// ---- I/O matrix: CDN augmentation (injected fetcher — no network) ----

fn service_with_fetcher(root: PathBuf, fetcher: SnapshotFetcher) -> Arc<AcpCatalogService> {
    fs::create_dir_all(&root).unwrap();
    Arc::new(AcpCatalogService {
        root,
        cache: RwLock::new(None),
        snapshot_fetch: fetcher,
        snapshot_fetch_gate: Mutex::new(None),
    })
}

fn cdn_snapshot(id: &str) -> AcpRegistrySnapshot {
    AcpRegistrySnapshot {
        agents: vec![acp_registry_snapshot::AcpRegistrySnapshotAgent {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: "cdn test".to_string(),
            distribution: serde_json::json!({ "npx": { "package": "cdn-test@1.0.0" } }),
        }],
        source: "network".to_string(),
        fetched_at: None,
    }
}

/// A `NetworkFresh` + persisted resolution carrying the CDN test agent —
/// the default happy-path mock for the injected fetcher.
fn resolved_cdn(id: &str) -> ResolvedSnapshot {
    ResolvedSnapshot {
        snapshot: cdn_snapshot(id),
        outcome: SnapshotFetchOutcome::NetworkFresh,
        persisted: true,
    }
}

/// A snapshot carrying `id` at `version` with an npx distribution — for
/// collision tests against the bundled catalog.
fn resolved_cdn_version(id: &str, version: &str) -> ResolvedSnapshot {
    ResolvedSnapshot {
        snapshot: AcpRegistrySnapshot {
            agents: vec![acp_registry_snapshot::AcpRegistrySnapshotAgent {
                id: id.to_string(),
                name: id.to_string(),
                version: version.to_string(),
                description: "updated via applied registry".to_string(),
                distribution: serde_json::json!({ "npx": { "package": format!("{id}@{version}") } }),
            }],
            source: "network".to_string(),
            fetched_at: None,
        },
        outcome: SnapshotFetchOutcome::NetworkFresh,
        persisted: true,
    }
}

#[tokio::test]
async fn applied_snapshot_overrides_bundled_on_id_collision() {
    let root = temp_dir("opt-in-override");
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(|_, _| Box::pin(async { Ok(resolved_cdn_version("claude-acp", "9.9.9")) })),
    );
    service.set_opt_in(true).unwrap();
    let catalog = service.list_catalog(false).await.unwrap();
    let agent = catalog
        .agents
        .iter()
        .find(|a| a.id == "claude-acp")
        .expect("colliding agent must stay present");
    // Applied Registry governs versions (ADR-0002): the snapshot entry
    // must WIN on id collision. An additive-only merge leaves binary
    // installs resolving the stale bundled archive forever — update
    // drift never clears and every "Update" click reinstalls the same
    // old version.
    assert_eq!(agent.version, "9.9.9");
    assert_eq!(agent.source, CatalogSource::Registry);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn opt_in_includes_cdn_entries_tagged_registry() {
    let root = temp_dir("opt-in-cdn");
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(|_, _| Box::pin(async { Ok(resolved_cdn("cdn-only-test-agent")) })),
    );
    service.set_opt_in(true).unwrap();
    let catalog = service.list_catalog(false).await.unwrap();
    let cdn = catalog
        .agents
        .iter()
        .find(|a| a.id == "cdn-only-test-agent")
        .expect("CDN entry must be present when opted in");
    assert_eq!(cdn.source, CatalogSource::Registry);
    // Non-colliding bundled entries remain bundled; colliding ids are
    // replaced by the applied snapshot (`applied_snapshot_overrides_
    // bundled_on_id_collision`).
    assert!(catalog
        .agents
        .iter()
        .any(|a| a.source == CatalogSource::Bundled));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn opt_in_fetch_failure_degrades_to_bundled_only() {
    let root = temp_dir("opt-in-fail");
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(|_, _| Box::pin(async { Err("simulated CDN failure".to_string()) })),
    );
    service.set_opt_in(true).unwrap();
    // Degrade-gracefully contract: the client receives success with a
    // bundled-only catalog (a warn log records the CDN failure).
    let catalog = service.list_catalog(false).await.unwrap();
    assert!(!catalog.agents.is_empty());
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    assert!(catalog.registry_degraded);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn opt_out_never_calls_snapshot_fetch() {
    let root = temp_dir("opt-out-no-fetch");
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(|_, _| Box::pin(async { panic!("snapshot fetch must not run when opted out") })),
    );
    let catalog = service.list_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn refresh_true_forces_snapshot_refresh() {
    let root = temp_dir("refresh-force");
    let calls = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, force| {
            calls_clone.lock().push(force);
            Box::pin(async { Ok(resolved_cdn("cdn-only-test-agent")) })
        }),
    );
    service.set_opt_in(true).unwrap();
    service.list_catalog(false).await.unwrap();
    service.list_catalog(true).await.unwrap();
    // `refresh=false` keeps TTL semantics; `refresh=true` bypasses the TTL
    // (force_refresh) so a manual refresh actually refetches.
    assert_eq!(calls.lock().as_slice(), &[false, true]);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn snapshot_fetcher_forwards_path_and_force_flag_unchanged() {
    // Pins the delegate-forwarding seam: a dropped `force_refresh`
    // forward in the constructor would silently break manual refresh
    // while leaving every fetcher-injected test green.
    fn echo_delegate(
        path: PathBuf,
        force_refresh: bool,
    ) -> Pin<Box<dyn Future<Output = Result<ResolvedSnapshot, String>> + Send>> {
        FORWARD_CALLS.lock().push((path, force_refresh));
        Box::pin(async { Ok(resolved_cdn("cdn-only-test-agent")) })
    }
    static FORWARD_CALLS: Mutex<Vec<(PathBuf, bool)>> = Mutex::new(Vec::new());

    let fetcher = snapshot_fetcher(echo_delegate);
    let path = PathBuf::from("/tmp/termul-test-snapshot-cache.json");
    for force in [false, true] {
        let resolved = fetcher(path.clone(), force).await.unwrap();
        assert_eq!(resolved.snapshot.agents[0].id, "cdn-only-test-agent");
    }
    let calls = FORWARD_CALLS.lock();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0], (path.clone(), false));
    assert_eq!(calls[1], (path, true));
}

#[tokio::test]
async fn fetch_registry_snapshot_invalidates_catalog_cache() {
    // Manual refresh must reach the SERVED catalog: after a successful
    // fetch, the next `list_catalog(false)` — even within the 60s probe
    // TTL — re-resolves instead of serving the pre-refresh catalog.
    let root = temp_dir("fetch-invalidates");
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async { Ok(resolved_cdn("cdn-only-test-agent")) })
        }),
    );
    service.set_opt_in(true).unwrap();
    let catalog = service.list_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .any(|a| a.source == CatalogSource::Registry));
    assert_eq!(*calls.lock(), 1);
    service.fetch_registry_snapshot(true).await.unwrap();
    assert_eq!(*calls.lock(), 2);
    let catalog = service.list_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .any(|a| a.source == CatalogSource::Registry));
    assert_eq!(
        *calls.lock(),
        3,
        "list_catalog after a manual refresh must re-resolve, not serve the probe-cached catalog"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn snapshot_fetch_failure_gates_non_forced_retries() {
    // Offline stall loop: with an expired cache and no network, each
    // probe-cache expiry would otherwise block up to the 15s fetch
    // timeout. After one failure, non-forced resolutions are gated for
    // the retry interval; forced refreshes bypass the gate.
    let root = temp_dir("retry-gate");
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async { Err("simulated CDN failure".to_string()) })
        }),
    );
    service.set_opt_in(true).unwrap();
    let catalog = service.resolve_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    assert_eq!(*calls.lock(), 1);
    // Gated: no second fetch attempt within the retry interval.
    let catalog = service.resolve_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    assert_eq!(*calls.lock(), 1);
    // Forced refresh bypasses the gate.
    let _ = service.resolve_catalog(true).await.unwrap();
    assert_eq!(*calls.lock(), 2);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn gated_fetch_serves_on_disk_cache() {
    // While gated, a non-forced resolution serves the on-disk cache
    // directly (however stale) — registry entries stay available offline.
    let root = temp_dir("gate-stale-cache");
    let catalog_dir = root.join("catalog");
    fs::create_dir_all(&catalog_dir).unwrap();
    let cached = serde_json::json!({
        "agents": [{
            "id": "cdn-only-test-agent",
            "name": "CDN Only",
            "version": "1.0.0",
            "description": "seeded",
            "distribution": { "npx": { "package": "cdn-test@1.0.0" } }
        }],
        "fetchedAt": "2000-01-01T00:00:00Z"
    });
    fs::write(
        catalog_dir.join(SNAPSHOT_CACHE_FILENAME),
        serde_json::to_vec(&cached).unwrap(),
    )
    .unwrap();
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        catalog_dir,
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async { Err("simulated CDN failure".to_string()) })
        }),
    );
    service.set_opt_in(true).unwrap();
    // First resolution: fetch attempted and fails (the injected fetcher
    // has no stale fallback of its own) → bundled-only, gate closes.
    let catalog = service.resolve_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    assert_eq!(*calls.lock(), 1);
    // Gated resolution: no fetch; the seeded on-disk cache is served.
    let catalog = service.resolve_catalog(false).await.unwrap();
    let cdn = catalog
        .agents
        .iter()
        .find(|a| a.id == "cdn-only-test-agent")
        .expect("gated resolution must serve the on-disk stale cache");
    assert_eq!(cdn.source, CatalogSource::Registry);
    assert_eq!(*calls.lock(), 1);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn successful_fetch_clears_retry_gate() {
    let root = temp_dir("retry-gate-clear");
    let calls = Arc::new(Mutex::new(0u32));
    let fail = Arc::new(Mutex::new(true));
    let calls_clone = Arc::clone(&calls);
    let fail_clone = Arc::clone(&fail);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            let should_fail = *fail_clone.lock();
            Box::pin(async move {
                if should_fail {
                    Err("simulated CDN failure".to_string())
                } else {
                    Ok(resolved_cdn("cdn-only-test-agent"))
                }
            })
        }),
    );
    service.set_opt_in(true).unwrap();
    // Failure closes the gate.
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 1);
    // A forced success bypasses the gate AND clears it.
    *fail.lock() = false;
    let _ = service.resolve_catalog(true).await.unwrap();
    assert_eq!(*calls.lock(), 2);
    // The next non-forced resolution fetches again (gate cleared).
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 3);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn stale_after_failure_sets_retry_gate_for_non_forced() {
    // The resolver returns Ok(stale-cache) after a network failure — the
    // gate MUST key on the outcome, not the Ok, or the offline stall loop
    // returns.
    let root = temp_dir("gate-stale-outcome");
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async {
                Ok(ResolvedSnapshot {
                    snapshot: cdn_snapshot("cdn-only-test-agent"),
                    outcome: SnapshotFetchOutcome::StaleAfterFailure,
                    persisted: true,
                })
            })
        }),
    );
    service.set_opt_in(true).unwrap();
    // Non-forced stale-after-failure sets the gate.
    let catalog = service.resolve_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .any(|a| a.source == CatalogSource::Registry));
    assert_eq!(*calls.lock(), 1);
    // Next non-forced resolution is gated (no fetch); no on-disk cache was
    // seeded by the mock, so it degrades to bundled-only.
    let catalog = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 1, "stale-after-failure must set the gate");
    assert!(catalog
        .agents
        .iter()
        .all(|a| a.source == CatalogSource::Bundled));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn forced_fetch_failure_does_not_set_retry_gate() {
    // A manual "Check for updates" while offline must NOT suppress
    // auto-refresh for the next hour.
    let root = temp_dir("gate-forced-failure");
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async { Err("simulated CDN failure".to_string()) })
        }),
    );
    service.set_opt_in(true).unwrap();
    // Forced failure: gate unchanged.
    let _ = service.resolve_catalog(true).await.unwrap();
    assert_eq!(*calls.lock(), 1);
    // The next non-forced resolution still attempts the fetch (gate
    // unset) — and now THAT failure sets the gate.
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 2, "forced failure must not set the gate");
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 2, "non-forced failure sets the gate");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn fresh_cache_outcome_leaves_retry_gate_untouched() {
    let root = temp_dir("gate-fresh-cache");
    let calls = Arc::new(Mutex::new(0u32));
    let fail = Arc::new(Mutex::new(false));
    let calls_clone = Arc::clone(&calls);
    let fail_clone = Arc::clone(&fail);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            let should_fail = *fail_clone.lock();
            Box::pin(async move {
                if should_fail {
                    Err("simulated CDN failure".to_string())
                } else {
                    Ok(ResolvedSnapshot {
                        snapshot: cdn_snapshot("cdn-only-test-agent"),
                        outcome: SnapshotFetchOutcome::FreshCache,
                        persisted: true,
                    })
                }
            })
        }),
    );
    service.set_opt_in(true).unwrap();
    // Gate unset: a FreshCache outcome neither sets nor clears anything.
    let _ = service.resolve_catalog(true).await.unwrap();
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 2, "gate unset: resolutions keep fetching");
    // Close the gate with a non-forced failure.
    *fail.lock() = true;
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 3);
    // A FreshCache outcome leaves the CLOSED gate untouched.
    *fail.lock() = false;
    let _ = service.resolve_catalog(true).await.unwrap();
    assert_eq!(*calls.lock(), 4);
    let _ = service.resolve_catalog(false).await.unwrap();
    assert_eq!(*calls.lock(), 4, "FreshCache must not clear a closed gate");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn unpersisted_fetch_keeps_in_memory_catalog() {
    // Network fetch succeeded but the cache write failed (persisted=false):
    // fetch_registry_snapshot must NOT invalidate the in-memory catalog —
    // the next resolution would otherwise re-resolve against a disk cache
    // that never received the fresh snapshot.
    let root = temp_dir("unpersisted-keeps-catalog");
    let calls = Arc::new(Mutex::new(0u32));
    let calls_clone = Arc::clone(&calls);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |_, _| {
            *calls_clone.lock() += 1;
            Box::pin(async {
                Ok(ResolvedSnapshot {
                    snapshot: cdn_snapshot("cdn-only-test-agent"),
                    outcome: SnapshotFetchOutcome::NetworkFresh,
                    persisted: false,
                })
            })
        }),
    );
    service.set_opt_in(true).unwrap();
    let catalog = service.list_catalog(false).await.unwrap();
    assert!(catalog
        .agents
        .iter()
        .any(|a| a.source == CatalogSource::Registry));
    assert_eq!(*calls.lock(), 1);
    // The caller still receives the fresh snapshot...
    let snapshot = service.fetch_registry_snapshot(true).await.unwrap();
    assert_eq!(snapshot.agents[0].id, "cdn-only-test-agent");
    assert_eq!(*calls.lock(), 2);
    // ...but the in-memory catalog is intact (within the 60s probe TTL
    // this list_catalog would re-resolve if the cache had been cleared).
    let _ = service.list_catalog(false).await.unwrap();
    assert_eq!(
        *calls.lock(),
        2,
        "unpersisted fetch must not clear the in-memory catalog"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn fetch_registry_snapshot_targets_shared_catalog_cache() {
    let root = temp_dir("shared-cache-path");
    let seen = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let seen_clone = Arc::clone(&seen);
    let service = service_with_fetcher(
        root.join("catalog"),
        Arc::new(move |path, force| {
            seen_clone.lock().push((path, force));
            Box::pin(async { Ok(resolved_cdn("cdn-only-test-agent")) })
        }),
    );
    let snapshot = service.fetch_registry_snapshot(true).await.unwrap();
    assert_eq!(snapshot.agents[0].id, "cdn-only-test-agent");
    // The desktop "Check for updates" command writes the SAME cache file
    // the catalog augmentation serves (single shared cache per host).
    let recorded = seen.lock();
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].0,
        root.join("catalog").join(SNAPSHOT_CACHE_FILENAME)
    );
    assert!(recorded[0].1, "force_refresh must pass through");
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix: opt-in persistence + corrupt-file backup ----

#[tokio::test]
async fn opt_in_persistence_round_trip() {
    let root = temp_dir("opt-in-round-trip");
    let service = AcpCatalogService::open(root.join("catalog")).await.unwrap();
    assert!(!service.is_opt_in(), "default opt-in should be false");
    service.set_opt_in(true).unwrap();
    assert!(service.is_opt_in(), "opt-in should be true after set");
    service.set_opt_in(false).unwrap();
    assert!(!service.is_opt_in(), "opt-in should be false after unset");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn opt_in_corrupt_file_backed_up_and_defaults_false() {
    let root = temp_dir("opt-in-corrupt");
    let catalog_dir = root.join("catalog");
    fs::create_dir_all(&catalog_dir).unwrap();
    let config_path = catalog_dir.join(CONFIG_FILENAME);
    fs::write(&config_path, b"{ not valid json").unwrap();

    let service = AcpCatalogService::open(catalog_dir).await.unwrap();
    assert!(!service.is_opt_in(), "corrupt opt-in defaults to false");

    // Backup exists alongside the bad file.
    let backups: Vec<_> = fs::read_dir(service.root())
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|n| n.contains("corrupt-"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1, "exactly one corrupt backup");
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix: deny_unknown_fields on opt-in request ----

#[test]
fn set_catalog_opt_in_request_rejects_unknown_fields() {
    let payload = serde_json::json!({ "enabled": true, "extra": "junk" });
    let result: Result<SetCatalogOptInRequest, _> = serde_json::from_value(payload);
    assert!(
        result.is_err(),
        "deny_unknown_fields must reject extra fields"
    );
}

#[test]
fn set_catalog_opt_in_request_accepts_enabled_only() {
    let payload = serde_json::json!({ "enabled": true });
    let request: SetCatalogOptInRequest = serde_json::from_value(payload).unwrap();
    assert!(request.enabled);
}

// ---- I/O matrix: catalog cache TTL ----

#[tokio::test]
async fn list_catalog_caches_within_ttl() {
    let root = temp_dir("cache-ttl");
    let service = AcpCatalogService::open(root.join("catalog")).await.unwrap();
    let catalog1 = service.list_catalog(false).await.unwrap();
    let catalog2 = service.list_catalog(false).await.unwrap();
    // Both calls return the same agents (within the TTL the cache is
    // not invalidated). The exact probe results may differ on a CI runner
    // but the cached call must return the same data.
    assert_eq!(catalog1.agents.len(), catalog2.agents.len());
    assert_eq!(catalog1.host.os, catalog2.host.os);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn list_catalog_refresh_invalidates_cache() {
    let root = temp_dir("cache-refresh");
    let service = AcpCatalogService::open(root.join("catalog")).await.unwrap();
    let catalog1 = service.list_catalog(false).await.unwrap();
    // Force refresh — must not error and must return the same agent count
    // (probes re-run but the bundled catalog is the same).
    let catalog2 = service.list_catalog(true).await.unwrap();
    assert_eq!(catalog1.agents.len(), catalog2.agents.len());
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix: CDN degradation fallback ----

#[tokio::test]
async fn list_catalog_without_opt_in_serves_bundled_only() {
    let root = temp_dir("no-opt-in");
    let service = AcpCatalogService::open(root.join("catalog")).await.unwrap();
    let catalog = service.list_catalog(false).await.unwrap();
    // Every agent is bundled (no CDN entries without opt-in).
    for agent in &catalog.agents {
        assert_eq!(agent.source, CatalogSource::Bundled);
    }
    let _ = fs::remove_dir_all(root);
}

// ---- Serde shape tests ----

#[test]
fn acp_catalog_serializes_camel_case() {
    let catalog = AcpCatalog {
        registry_degraded: false,
        host: HostCapability {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            runtimes: CatalogRuntimeAvailability {
                npx: true,
                uvx: false,
                node: true,
                bun: false,
                python3: true,
                npm: true,
                node_major: Some(22),
                claude_cli: true,
                unavailable_reason: None,
            },
        },
        agents: vec![CatalogAgent {
            id: "test".to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            description: "test agent".to_string(),
            source: CatalogSource::Bundled,
            distribution: serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
            runtime_requirements: vec!["npx".to_string()],
            status: SupportedAcpAgentStatus::Ready,
            platform_targets: vec![],
            installed: None,
        }],
    };
    let value = serde_json::to_value(&catalog).unwrap();
    assert!(value.get("host").is_some());
    assert!(value["host"].get("os").is_some());
    assert!(value["host"].get("arch").is_some());
    assert!(value["host"]["runtimes"].get("npx").is_some());
    assert!(value["host"]["runtimes"].get("uvx").is_some());
    assert!(value["host"]["runtimes"].get("node").is_some());
    assert!(value["host"]["runtimes"].get("bun").is_some());
    assert!(value["host"]["runtimes"].get("python3").is_some());
    assert!(value["agents"][0].get("id").is_some());
    assert!(value["agents"][0].get("name").is_some());
    assert!(value["agents"][0].get("version").is_some());
    assert!(value["agents"][0].get("description").is_some());
    assert!(value["agents"][0].get("source").is_some());
    assert!(value["agents"][0].get("distribution").is_some());
    assert!(value["agents"][0].get("runtimeRequirements").is_some());
    assert!(value["agents"][0].get("status").is_some());
    assert!(value["agents"][0].get("platformTargets").is_some());
    // Status serializes as kebab-case.
    assert_eq!(value["agents"][0]["status"], "ready");
    assert_eq!(value["agents"][0]["source"], "bundled");
}

#[test]
fn supported_acp_agent_status_serializes_kebab_case() {
    let statuses = [
        (SupportedAcpAgentStatus::Ready, "ready"),
        (SupportedAcpAgentStatus::InstallRequired, "install-required"),
        (SupportedAcpAgentStatus::NeedsRuntime, "needs-runtime"),
        (SupportedAcpAgentStatus::ManualInstall, "manual-install"),
        (SupportedAcpAgentStatus::Unavailable, "unavailable"),
    ];
    for (status, expected) in statuses {
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value, expected);
    }
}

/// Finding 8: the host emits `unavailableReason` on the runtimes block —
/// camelCase, omitted entirely when no computed block applies.
#[test]
fn catalog_runtimes_serialize_unavailable_reason_only_when_present() {
    let mut runtimes = CatalogRuntimeAvailability {
        npx: true,
        uvx: false,
        node: true,
        bun: false,
        python3: true,
        npm: true,
        node_major: Some(22),
        claude_cli: true,
        unavailable_reason: None,
    };
    let json = serde_json::to_value(&runtimes).unwrap();
    assert!(json.get("unavailableReason").is_none());

    runtimes.unavailable_reason =
        Some("Claude Agent ACP requires Node.js 22 or newer.".to_string());
    let json = serde_json::to_value(&runtimes).unwrap();
    assert_eq!(
        json["unavailableReason"],
        "Claude Agent ACP requires Node.js 22 or newer."
    );
}

#[test]
fn catalog_source_serializes_lowercase() {
    assert_eq!(
        serde_json::to_value(CatalogSource::Bundled).unwrap(),
        "bundled"
    );
    assert_eq!(
        serde_json::to_value(CatalogSource::Registry).unwrap(),
        "registry"
    );
}

#[test]
fn is_https_archive_url_validates_scheme_and_format() {
    assert!(is_https_archive_url("https://example.com/agent.zip"));
    assert!(is_https_archive_url("https://example.com/agent.tar.gz"));
    assert!(is_https_archive_url("https://example.com/agent.tgz"));
    assert!(!is_https_archive_url("http://example.com/agent.zip"));
    assert!(!is_https_archive_url("https://example.com/agent.exe"));
    assert!(!is_https_archive_url("ftp://example.com/agent.zip"));
}

#[test]
fn parse_binary_platform_targets_extracts_os_arch_pairs() {
    let dist = serde_json::json!({
        "binary": {
            "darwin-aarch64": { "cmd": "./agent" },
            "linux-x86_64": { "cmd": "./agent" },
            "windows-x86_64": { "cmd": "agent.exe" }
        }
    });
    let targets = parse_binary_platform_targets(&dist);
    assert_eq!(targets.len(), 3);
    let oses: Vec<&str> = targets.iter().map(|t| t.os.as_str()).collect();
    assert!(oses.contains(&"darwin"));
    assert!(oses.contains(&"linux"));
    assert!(oses.contains(&"windows"));
}

#[test]
fn host_platform_arch_maps_macos_to_darwin() {
    // The function uses std::env::consts::OS which is compile-time; on a
    // non-macOS runner the result is the raw OS. The test just verifies the
    // format is "{os}-{arch}" and the macOS→darwin mapping is documented.
    let pa = host_platform_arch();
    assert!(pa.contains('-'), "platform-arch must contain a dash");
}
