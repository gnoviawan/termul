//! Unit coverage for the npx-cache self-heal (issue #1413). The env-dependent
//! paths (`heal_npx_cache`) run with a serialized process-wide lock because
//! `npm_config_cache`/`HOME` are process-global.

use super::*;

/// Guards `npm_config_cache`/`HOME` while a test mutates them.
struct NpmEnvGuard {
    cache: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
}

impl NpmEnvGuard {
    fn install(cache: Option<&str>) -> Self {
        let guard = Self {
            cache: std::env::var_os("npm_config_cache"),
            home: std::env::var_os("HOME"),
        };
        if let Some(dir) = cache {
            std::env::set_var("npm_config_cache", dir);
        } else {
            std::env::remove_var("npm_config_cache");
        }
        std::env::set_var("HOME", "/nonexistent-termul-home");
        guard
    }
}

impl Drop for NpmEnvGuard {
    fn drop(&mut self) {
        if let Some(cache) = self.cache.take() {
            std::env::set_var("npm_config_cache", cache);
        } else {
            std::env::remove_var("npm_config_cache");
        }
        if let Some(home) = self.home.take() {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

/// npm's real broken-entry report shape (from the issue, Linux + macOS logs).
const LINUX_FAILURE: &str = "Process exited with exit status: 254: npm error code ENOENT\nnpm error syscall open\nnpm error path /home/ubuntu/.npm/_npx/4a4ca55c38a52b9f/package.json\nnpm error errno -2";

const MACOS_FAILURE: &str = "Process exited with exit status: 254: npm error code ENOENT\nnpm error syscall open\nnpm error path /Users/insankhamil/.npm/_npx/2226a678236ff29a/package.json\nnpm error errno -2";

#[test]
fn recognizes_the_real_linux_and_macos_signatures() {
    assert!(is_broken_npx_cache_failure(LINUX_FAILURE));
    assert!(is_broken_npx_cache_failure(MACOS_FAILURE));
}

#[test]
fn ignores_failures_without_the_npm_cache_signature() {
    // A timeout with no stderr tail: the pre-fix user-visible failure.
    assert!(!is_broken_npx_cache_failure(
        "agent initialize failed: initialize timed out after 30s"
    ));
    // The transport-closed shape.
    assert!(!is_broken_npx_cache_failure(
        "agent initialize failed: Incoming transport closed: {\"reason\":\"incoming_transport_closed\",\"method\":\"initialize\"}"
    ));
    // An agent echoing a filesystem ENOENT of its own: no `npm error` prefix.
    assert!(!is_broken_npx_cache_failure(
        "agent initialize failed: no such file or directory: /tmp/project/missing.json"
    ));
    // npm ENOENT naming a path outside the npx cache (broken spec, not entry).
    assert!(!is_broken_npx_cache_failure(
        "npm error code ENOENT\nnpm error path /home/ubuntu/project/package.json"
    ));
    // npm ENOENT naming a `_npx`-adjacent directory that is not an entry.
    assert!(!is_broken_npx_cache_failure(
        "npm error code ENOENT\nnpm error path /home/ubuntu/.npm/_npx/zz/package.json"
    ));
}

#[test]
fn detects_windows_shaped_paths_and_shims() {
    let windows = "Process exited with exit code 254: npm error code ENOENT\nnpm error syscall open\nnpm error path C:\\Users\\alice\\.npm\\_npx\\2226a678236ff29a\\package.json\nnpm error errno -4058";
    assert!(is_broken_npx_cache_failure(windows));

    let config = |command: &str| crate::acp::config::AgentConfig {
        config_id: Some("acp-registry:codex-acp".to_string()),
        name: "codex".to_string(),
        command: command.to_string(),
        args: vec!["-y".to_string()],
        env: std::collections::HashMap::new(),
        allow_terminal: false,
    };
    assert!(launches_via_npx(&config("npx")));
    assert!(launches_via_npx(&config("C:\\Program Files\\nodejs\\npx.cmd")));
    assert!(!launches_via_npx(&config("node")));
    assert!(!launches_via_npx(&config("/usr/bin/uvx")));
    assert!(!launches_via_npx(&config("bunx")));
}

#[test]
fn heals_only_a_broken_entry_under_the_cache_root() {
    let dir = std::env::temp_dir().join(format!("termul-npx-heal-{}", uuid::Uuid::new_v4()));
    let root = dir.join("npm-cache");
    let entry = root.join("_npx").join("4a4ca55c38a52b9f");
    std::fs::create_dir_all(&entry).unwrap();
    let failure = format!(
        "npm error code ENOENT\nnpm error path {}/package.json",
        entry.display()
    );
    {
        let _guard = NpmEnvGuard::install(Some(root.to_str().unwrap()));
        assert!(is_broken_npx_cache_failure(&failure));

        // A populated node_modules with no package.json: the broken shape.
        std::fs::create_dir_all(entry.join("node_modules")).unwrap();
        let removed = heal_npx_cache(&failure).expect("the broken entry is removed");
        assert_eq!(removed, entry);
        assert!(!entry.exists(), "the entry directory is gone");
        // Healing is once: a second heal finds nothing left to remove.
        assert!(heal_npx_cache(&failure).is_none());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keeps_a_healthy_entry_and_ignores_entries_outside_the_root() {
    let dir = std::env::temp_dir().join(format!("termul-npx-healthy-{}", uuid::Uuid::new_v4()));
    let root = dir.join("npm-cache");
    let healthy = root.join("_npx").join("2226a678236ff29a");
    std::fs::create_dir_all(&healthy).unwrap();
    std::fs::write(healthy.join("package.json"), "{}").unwrap();
    let healthy_failure = format!(
        "npm error code ENOENT\nnpm error path {}/package.json",
        healthy.display()
    );

    // An entry with its manifest is healthy: no removal.
    {
        let _guard = NpmEnvGuard::install(Some(root.to_str().unwrap()));
        assert!(heal_npx_cache(&healthy_failure).is_none());
        assert!(healthy.join("package.json").is_file());
    }

    // An entry outside the configured cache root is never touched.
    let other = dir.join("elsewhere").join("_npx").join("418c4d09cf1582a6");
    std::fs::create_dir_all(&other).unwrap();
    let outside_failure = format!(
        "npm error code ENOENT\nnpm error path {}/package.json",
        other.display()
    );
    {
        let _guard = NpmEnvGuard::install(Some(root.to_str().unwrap()));
        assert!(heal_npx_cache(&outside_failure).is_none());
        assert!(other.is_dir(), "an entry outside the cache root survives");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// npm's `npm error enoent Could not read package.json: …` line also names
/// the entry; both `npm error path` and `npm error enoent` wording heal.
#[test]
fn parses_the_enoent_wording_too() {
    let failure = "npm error code ENOENT\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/home/ubuntu/.npm/_npx/4a4ca55c38a52b9f/package.json'";
    assert!(is_broken_npx_cache_failure(failure));
}
