use super::*;

/// Percent-encode a filesystem path for use as a query-string value in a
/// test URL (Windows backslashes, spaces, etc. would otherwise break the
/// URL parse). Mirrors the `urlencoding` helper in `git_api::tests`.
fn percent_encode_path(path: &std::path::Path) -> String {
    let mut out = String::with_capacity(path.as_os_str().len());
    for c in path.to_string_lossy().chars() {
        match c {
            ' ' => out.push_str("%20"),
            '\\' => out.push_str("%5C"),
            _ if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/' | ':') => {
                out.push(c)
            }
            _ => {
                for byte in c.to_string().as_bytes() {
                    out.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    out
}

#[test]
fn remote_bind_mode_parse() {
    assert_eq!(
        RemoteBindMode::parse("localhost"),
        Some(RemoteBindMode::Localhost)
    );
    assert_eq!(
        RemoteBindMode::parse("127.0.0.1"),
        Some(RemoteBindMode::Localhost)
    );
    assert_eq!(RemoteBindMode::parse("all"), Some(RemoteBindMode::All));
    assert_eq!(RemoteBindMode::parse("0.0.0.0"), Some(RemoteBindMode::All));
    assert_eq!(RemoteBindMode::parse("any"), Some(RemoteBindMode::All));
    assert_eq!(RemoteBindMode::parse("bogus"), None);
}

#[test]
fn remote_bind_mode_host_and_display() {
    assert_eq!(RemoteBindMode::Localhost.host(), "127.0.0.1");
    assert_eq!(RemoteBindMode::All.host(), "0.0.0.0");
    assert_eq!(RemoteBindMode::Localhost.display_host(), "127.0.0.1");
    assert_eq!(RemoteBindMode::All.display_host(), "0.0.0.0");
}

#[test]
fn remote_bind_mode_is_lan_exposed() {
    assert!(!RemoteBindMode::Localhost.is_lan_exposed());
    assert!(RemoteBindMode::All.is_lan_exposed());
}

#[test]
fn remote_status_stopped_is_all_none() {
    let s = RemoteStatus::stopped();
    assert!(!s.running);
    assert_eq!(s.url, None);
    assert_eq!(s.port, None);
    assert_eq!(s.bind_mode, None);
    assert_eq!(s.bind_host, None);
    assert_eq!(s.tunnel_url, None);
}

#[test]
fn remote_status_running_localhost_uses_loopback_url() {
    let addr: SocketAddr = "127.0.0.1:5123".parse().unwrap();
    let s = RemoteStatus::running(addr, RemoteBindMode::Localhost, None);
    assert!(s.running);
    assert_eq!(s.url.as_deref(), Some("http://127.0.0.1:5123"));
    assert_eq!(s.port, Some(5123));
    assert_eq!(s.bind_mode.as_deref(), Some("localhost"));
    assert_eq!(s.bind_host.as_deref(), Some("127.0.0.1"));
    assert_eq!(s.tunnel_url, None);
}

#[test]
fn remote_status_running_carries_tunnel_url() {
    let addr: SocketAddr = "127.0.0.1:5123".parse().unwrap();
    let s = RemoteStatus::running(
        addr,
        RemoteBindMode::Localhost,
        Some("https://foo-bar.trycloudflare.com".to_string()),
    );
    assert_eq!(
        s.tunnel_url.as_deref(),
        Some("https://foo-bar.trycloudflare.com")
    );
}

#[test]
fn remote_status_running_all_has_no_url() {
    // Bound to 0.0.0.0: the host's LAN IP can't be derived from the bind
    // address, so `url` is `None` (the UI shows "use this machine's LAN
    // IP:{port}"). Don't fabricate a loopback URL the phone can't reach.
    let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    let s = RemoteStatus::running(addr, RemoteBindMode::All, None);
    assert!(s.running);
    assert_eq!(s.url, None, "0.0.0.0 must not fabricate a loopback URL");
    assert_eq!(s.port, Some(8080));
    assert_eq!(s.bind_mode.as_deref(), Some("all"));
    assert_eq!(s.bind_host.as_deref(), Some("0.0.0.0"));
}

#[tokio::test]
async fn remote_server_state_stop_on_unstarted_errors() {
    // A stop on an unstarted state must error; status reports stopped.
    let state = RemoteServerState::new();
    assert!(!state.status().running);

    let err = state.stop().await;
    assert!(err.is_err(), "stop on an unstarted server must error");
    assert!(!state.status().running);
}

/// A real `AcpManager` (zero sinks is legal) + a `WsRelaySink` for the
/// shared-live host lifecycle tests. The serve task binds a real OS-assigned
/// localhost socket — safe in tests.
fn lifecycle_fixtures() -> (
    Arc<AcpManager>,
    Arc<PtyManager>,
    Arc<WsRelaySink>,
    Arc<ProjectRegistry>,
) {
    let acp = Arc::new(AcpManager::new(vec![]));
    let pty = crate::web::test_pty_manager();
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    (acp, pty, relay, registry)
}

#[tokio::test]
async fn remote_server_state_start_then_stop_lifecycle() {
    // The full start→status(running)→stop→status(stopped)→restart cycle
    // that T8.1 asked for and the old misnamed test never exercised.
    let (acp, pty, relay, registry) = lifecycle_fixtures();
    let state = RemoteServerState::new();
    assert!(!state.status().running);

    let status = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("start on localhost binds an OS-assigned port");
    assert!(status.running, "start returns a running status");
    assert!(status.port.is_some(), "an OS-assigned port is reported");
    assert!(
        state.status().running,
        "status reflects running after start"
    );
    assert_eq!(state.status().port, status.port);

    // stop drains the serve task (the JoinHandle is awaited) and reports stopped.
    let stopped = state
        .stop()
        .await
        .expect("stop on a running server succeeds");
    assert!(!stopped.running);
    assert!(
        !state.status().running,
        "status reflects stopped after stop"
    );

    // Restart works (the slot was cleared by stop).
    let again = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("restart after stop succeeds");
    assert!(again.running);
    let _ = state.stop().await;
}

#[tokio::test]
async fn remote_server_state_double_start_is_rejected() {
    // The lose-race guard: a second start while the first is running returns
    // Err — and (per R1) does NOT orphan a second server (its shutdown_tx is
    // signaled before returning). The first server keeps running.
    let (acp, pty, relay, registry) = lifecycle_fixtures();
    let state = RemoteServerState::new();
    let _first = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("first start succeeds");

    let second = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await;
    assert!(
        second.is_err(),
        "a second start while running must be rejected"
    );
    assert!(state.status().running, "the first server is still running");

    let _ = state.stop().await;
}

#[tokio::test]
async fn remote_server_state_start_stop_does_not_kill_agents() {
    // The central AC4 guarantee: toggling the shared-live server off must NOT
    // kill the desktop's live agents. `serve_router` (which host::start
    // calls) never calls `AcpManager::kill_all`; `stop` only signals the
    // oneshot. Drive the full lifecycle and assert no agent state was
    // disturbed. (AcpManager::new(vec![]) owns no agents, so there is
    // nothing to kill — this guards the path: start/stop complete without
    // touching kill_all, i.e. no panic, no error, clean drain.)
    let (acp, pty, relay, registry) = lifecycle_fixtures();
    let state = RemoteServerState::new();
    let _ = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("start succeeds");
    // The serve task holds `Arc::clone(&acp)`; stop drains it. The desktop
    // `acp` is untouched (still usable, agents survive).
    let stopped = state.stop().await.expect("stop succeeds");
    assert!(!stopped.running);
    // `acp` is still intact — the host never called kill_all on it. (No
    // direct kill_all assertion possible without a spy; the invariant is
    // structural: serve_router does not call kill_all, host::stop does not
    // call kill_all. This test guards the path end-to-end.)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_clears_tunnel_url_when_cloudflared_child_exits() {
    // The watchdog flips `tunnel_dead` once the child exits; `status()`
    // then clears `tunnel_url` so the renderer poller drops the stale QR
    // (it would otherwise offer a link that yields "This site can't be
    // reached").
    let (acp, pty, relay, registry) = lifecycle_fixtures();
    let state = RemoteServerState::new();
    let _ = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("start");

    // Attach a tunnel child that exits almost immediately (cross-platform
    // exit-0). kill_on_drop mirrors the real start_quick_tunnel child.
    let mut cmd = quick_exit_command();
    cmd.kill_on_drop(true);
    let child = cmd.spawn().expect("spawn quick-exit child");
    state
        .attach_tunnel("https://stale.trycloudflare.com".to_string(), child)
        .expect("attach");

    // Poll status until the dead-child path clears the tunnel URL. The
    // child exits within a few ms; allow up to 1s for the OS + watchdog.
    let mut cleared = false;
    for _ in 0..20 {
        let s = state.status();
        if s.running && s.tunnel_url.is_none() {
            cleared = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        cleared,
        "status() must clear tunnel_url once cloudflared exits"
    );

    let _ = state.stop().await;
}

/// A cross-platform command that exits 0 almost immediately, for the
/// dead-child staleness test.
fn quick_exit_command() -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    let mut c = tokio::process::Command::new("cmd");
    #[cfg(target_os = "windows")]
    c.args(["/c", "exit", "0"]);
    #[cfg(not(target_os = "windows"))]
    let mut c = tokio::process::Command::new("true");

    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    c
}

#[test]
fn serve_router_does_not_reference_kill_all() {
    // Structural regression guard for the story's "single most important
    // fact" (Dev Notes invariant #2 / AC4): the desktop-hosted shared-live
    // path calls `serve_router` directly, so `serve_router` must never call
    // `AcpManager::kill_all` — toggling the server off must not kill the
    // desktop's live agents. (The standalone `serve()` wrapper IS allowed to
    // call `kill_all` — it owns its agents — so only `serve_router`'s body
    // is scanned, not the whole module.) If `kill_all` is re-added to
    // `serve_router`, this test fails. The end-to-end lifecycle test above
    // guards the path at runtime; this one pins the source invariant.
    let web_mod = include_str!("../../web/mod.rs");
    let body = extract_fn_body(web_mod, "serve_router")
        .expect("serve_router must be defined in web/mod.rs");
    let stripped = strip_line_comments(&body);
    assert!(
        !stripped.contains("kill_all"),
        "serve_router must not reference `kill_all` (the shared-live path must \
             not kill the desktop's agents) — re-adding it would regress AC4"
    );
}

/// Extract a top-level `fn`/`async fn` body by name, from its signature
/// line up to (but not including) the next top-level `fn`/`async fn`.
fn extract_fn_body(src: &str, fn_name: &str) -> Option<String> {
    let needle = format!("fn {fn_name}");
    let start = src.find(&needle)?;
    // Find the next top-level `fn ` after the signature (closes the body).
    let rest = &src[start + needle.len()..];
    let end = rest
        .find("\nfn ")
        .or_else(|| rest.find("\nasync fn "))
        .unwrap_or(rest.len());
    Some(src[start..start + needle.len() + end].to_string())
}

/// Strip `//` line comments so doc references to a token don't trip the
/// check. Crude but sufficient — these functions hold no string literals
/// containing `kill_all`.
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(idx) => &line[..idx],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn remote_server_state_default_equals_new() {
    let _ = RemoteServerState::default();
}

/// CAP-1 / CAP-8: the keystone cross-drive integration test.
///
/// Seeds a `ProjectRegistry` with a default project whose path is provably
/// OUTSIDE the user home tree, starts `RemoteServerState`, and asserts
/// `GET /skills` + `POST /git/status` pass the containment check (not
/// `OUTSIDE_PROJECT_ROOT`) over the real shared-live HTTP socket. Then
/// switches the default to a second project and asserts the new project is
/// accepted WITHOUT a server restart — proving the live rebind threads
/// through.
///
/// The bug this guards against is the `project_root = %USERPROFILE%` (home)
/// binding that rejects every project outside the home tree. To reproduce
/// that rejection, the project dirs MUST NOT be under the home dir. On
/// Windows `std::env::temp_dir()` resolves to `%USERPROFILE%\AppData\Local\
/// Temp` — i.e. INSIDE the home tree — so using it would let the buggy
/// `project_root = home` code accept the project (false pass). We instead
/// derive the project dirs from an outside-home base: `$TERMUL_TEST_OUTSIDE_
/// HOME_BASE` when set (so CI can pin a known-writable path outside home),
/// falling back to `home.parent()` (a sibling of home) when unset. If the
/// base cannot be resolved or (without an override) is not writable, the
/// test skips rather than false-pass; an explicit override that is unusable
/// panics so a broken CI setup is loud, not silent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_live_binds_project_root_to_active_cross_drive_project() {
    let (acp, pty, relay, registry) = lifecycle_fixtures();

    // Resolve the user home dir the way the buggy `default_project_root()`
    // does, then pick a base provably OUTSIDE the home tree so the project
    // dirs reproduce the cross-drive / outside-home rejection the bug caused.
    let Some(home) = crate::web::config::default_project_root() else {
        eprintln!("skip: cannot resolve user home dir for cross-drive test");
        return;
    };
    // `$TERMUL_TEST_OUTSIDE_HOME_BASE` lets CI pin a known-writable path
    // outside home (e.g. `/var/tmp` or a separate drive on runners where
    // `home.parent()` is locked down). When unset, fall back to
    // `home.parent()`. An explicit override that is unusable is a hard
    // error — the operator asked for it, so a silent skip would mask a
    // broken setup.
    let override_set = std::env::var_os("TERMUL_TEST_OUTSIDE_HOME_BASE").is_some();
    let outside_base = match std::env::var("TERMUL_TEST_OUTSIDE_HOME_BASE") {
        Ok(raw) if !raw.trim().is_empty() => std::path::PathBuf::from(raw.trim()),
        _ => match home.parent() {
            Some(p) => p.to_path_buf(),
            None => {
                eprintln!(
                    "skip: home dir has no parent and \
                         TERMUL_TEST_OUTSIDE_HOME_BASE is unset"
                );
                return;
            }
        },
    };
    // Probe the base is writable. An explicit override that is not writable
    // panics (CI must not silently skip a test the operator forced on);
    // without an override, skip silently — local dev may lack a writable
    // outside-home path.
    let probe = outside_base.join(format!(
        "termul-xdrive-probe-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    if std::fs::create_dir_all(&probe).is_err() {
        if override_set {
            panic!(
                "TERMUL_TEST_OUTSIDE_HOME_BASE='{}' is not writable; CI cannot \
                     run the cross-drive test reliably — fix the override path",
                outside_base.display()
            );
        }
        eprintln!(
            "skip: cannot write outside-home base '{}'; cross-drive layout \
                 not reproducible on this filesystem (set \
                 TERMUL_TEST_OUTSIDE_HOME_BASE to force)",
            outside_base.display()
        );
        return;
    }
    let _ = std::fs::remove_dir_all(&probe);

    // RAII cleanup guards — remove the dirs even if an assertion panics
    // mid-test (avoids leaking random-named dirs on the dev/CI machine).
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let dir_a = outside_base.join(format!(
        "termul-cross-drive-a-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let dir_b = outside_base.join(format!(
        "termul-cross-drive-b-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir_a).expect("create dir_a outside home");
    std::fs::create_dir_all(&dir_b).expect("create dir_b outside home");
    let _guard_a = TempDirGuard(dir_a.clone());
    let _guard_b = TempDirGuard(dir_b.clone());

    // Sanity: the project dirs are provably outside the home tree. If this
    // ever fails (unexpected home layout), the test would false-pass — skip.
    let home_canonical = home.canonicalize().unwrap_or_else(|_| home.clone());
    let dir_a_canonical = dir_a.canonicalize().unwrap_or_else(|_| dir_a.clone());
    if dir_a_canonical.starts_with(&home_canonical) {
        eprintln!(
            "skip: project dir '{}' is inside home '{}'; cross-drive layout \
                 not reproducible",
            dir_a_canonical.display(),
            home_canonical.display()
        );
        return;
    }

    // Optionally init a git repo in dir_a so /git/status can return a real
    // status (not just pass the containment check). When git is unavailable
    // the route still exercises the containment boundary and returns
    // GIT_STATUS_ERROR — never OUTSIDE_PROJECT_ROOT.
    let git_available = crate::trackers::GitTracker::run_git_command(
        std::env::temp_dir().to_str().unwrap(),
        &["--version"],
    )
    .is_some();
    if git_available {
        for args in [
            ["init", "-q"].as_slice(),
            ["config", "user.email", "t@example.com"].as_slice(),
            ["config", "user.name", "Test"].as_slice(),
            ["config", "commit.gpgsign", "false"].as_slice(),
        ] {
            let out = crate::trackers::GitTracker::run_git_command(dir_a.to_str().unwrap(), args)
                .expect("git command runs");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::fs::write(dir_a.join("README.md"), "hello\n").expect("write file");
    }

    // Seed the registry with both projects; dir_a is the default (the
    // "active" project the host should bind to).
    let project_a = crate::web::ProjectSummary {
        id: "p-a".to_string(),
        name: "Project A".to_string(),
        color: "blue".to_string(),
        path: Some(dir_a.to_string_lossy().into_owned()),
        is_archived: false,
        is_default: true,
    };
    let project_b = crate::web::ProjectSummary {
        id: "p-b".to_string(),
        name: "Project B".to_string(),
        color: "green".to_string(),
        path: Some(dir_b.to_string_lossy().into_owned()),
        is_archived: false,
        is_default: false,
    };
    registry.set(vec![project_a, project_b], Some("p-a".to_string()));

    // Start the shared-live server. CAP-1: `start` now derives project_root
    // from the registry default (dir_a), NOT the user home dir.
    let state = RemoteServerState::new();
    let status = state
        .start(
            acp.clone(),
            pty.clone(),
            relay.clone(),
            registry.clone(),
            RemoteBindMode::Localhost,
            None,
            None,
            None,
        )
        .await
        .expect("start with a cross-drive project must succeed");
    assert!(status.running, "server should be running");
    let url = status
        .url
        .expect("localhost bind produces a loopback URL")
        .clone();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("build reqwest client");

    // GET /skills?projectRoot=dir_a — must succeed (not OUTSIDE_PROJECT_ROOT).
    // The route canonicalizes dir_a and checks it against project_root
    // (which is now dir_a's canonical form, not the home dir). Build the
    // URL with percent-encoding so Windows backslash paths parse correctly.
    let skills_url_a = format!("{url}/skills?projectRoot={}", percent_encode_path(&dir_a));
    let resp = client.get(&skills_url_a).send().await.expect("GET /skills");
    let body: serde_json::Value = resp.json().await.expect("parse /skills body");
    // The containment claim is "not OUTSIDE_PROJECT_ROOT" — do NOT also
    // assert success==true, since /skills success depends on the global
    // skills scan (~/.agents/skills) which may be unreadable/empty in CI
    // for reasons unrelated to the boundary fix. The cross-drive fix is
    // proven by the absence of the OUTSIDE_PROJECT_ROOT rejection.
    assert!(
        body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
        "/skills must not reject the active project (cross-drive fix), got: {body}"
    );

    // POST /git/status { cwd: dir_a } — must not be OUTSIDE_PROJECT_ROOT.
    // When git is available + repo initialized, returns success with a
    // status list; otherwise GIT_STATUS_ERROR (the containment check still
    // passed).
    let resp = client
        .post(format!("{url}/git/status"))
        .json(&serde_json::json!({ "cwd": dir_a.to_string_lossy() }))
        .send()
        .await
        .expect("POST /git/status");
    let body: serde_json::Value = resp.json().await.expect("parse /git/status body");
    assert!(
        body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
        "/git/status must not reject the active project (cross-drive fix), got: {body}"
    );
    if git_available {
        assert!(
            body.get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            "/git/status should succeed for a git repo, got: {body}"
        );
    }

    // ---- Switch the default to project B (dir_b) WITHOUT a restart ----
    // CAP-1: the registry's set_default_project triggers rebind_project_root,
    // which recomputes project_root from the new default (dir_b) and writes
    // the canonical path to the AppState.project_root handle in place.
    assert!(
        registry.set_default_project("p-b"),
        "set_default_project must succeed for a switchable project"
    );

    // GET /skills?projectRoot=dir_b — must succeed with the new boundary.
    let skills_url_b = format!("{url}/skills?projectRoot={}", percent_encode_path(&dir_b));
    let resp = client
        .get(&skills_url_b)
        .send()
        .await
        .expect("GET /skills after switch");
    let body: serde_json::Value = resp.json().await.expect("parse /skills body");
    // Containment claim only (see above) — do not couple to skills-scan success.
    assert!(
        body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
        "/skills must not reject the new active project after switch, got: {body}"
    );

    // CAP-2 (PR #557) widened the operation boundary from "the default
    // root only" to "the default root OR any registered, non-archived
    // root" — see `ensure_within_project_boundary` and
    // `is_within_any_registered_root`. So after the switch, dir_a is STILL
    // admitted (p-a remains registered + non-archived) even though it is
    // no longer the default. To prove the rebound boundary actually moved
    // (and did not just widen to cover both), archive p-a — an archived
    // root is excluded from `is_within_any_registered_root` — and THEN
    // assert the rejection. Asserting rejection without archiving would
    // contradict the CAP-2 contract the production code implements (this
    // test predated #557; its last assertion was stale, not the code).
    assert!(
        registry.update("p-a", None, None, Some(true)),
        "archiving p-a must succeed"
    );
    // The old project (dir_a) is now outside BOTH the rebound default
    // (dir_b) and every non-archived registered root, so
    // /skills?projectRoot=dir_a must be rejected with
    // OUTSIDE_PROJECT_ROOT — proving the boundary moved to dir_b.
    let resp = client
        .get(&skills_url_a)
        .send()
        .await
        .expect("GET /skills old project after archive");
    let body: serde_json::Value = resp.json().await.expect("parse /skills body");
    assert_eq!(
            body.get("code").and_then(|v| v.as_str()),
            Some("OUTSIDE_PROJECT_ROOT"),
            "the old project must be rejected after the boundary moved to dir_b (and p-a archived), got: {body}"
        );

    let _ = state.stop().await;
    // dir_a / dir_b are removed by the TempDirGuard RAII guards on drop,
    // even if an assertion above panicked.
}
