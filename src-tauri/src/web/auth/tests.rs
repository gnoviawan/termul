use super::*;

/// Unique temp dir per test (removed on Drop, including panic paths).
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "termul-web-auth-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn token_debug_redacts_secret() {
    let token = WebAuthToken::new("super-secret-value").expect("non-empty");
    let dbg = format!("{token:?}");
    assert!(
        !dbg.contains("super-secret-value"),
        "debug must redact: {dbg}"
    );
    let auth = WebAuth::new(token);
    let dbg = format!("{auth:?}");
    assert!(
        !dbg.contains("super-secret-value"),
        "debug must redact: {dbg}"
    );
}

#[test]
fn token_new_trims_and_rejects_empty() {
    assert!(WebAuthToken::new("").is_none());
    assert!(WebAuthToken::new("   \n").is_none());
    assert_eq!(
        WebAuthToken::new("  abc \n").expect("non-empty").as_str(),
        "abc"
    );
}

#[test]
fn token_equality_is_exact_and_total() {
    // `PartialEq` is implemented with `subtle::ConstantTimeEq` (no
    // early-exit byte compare). Behaviorally: exact match only, across
    // length mismatches and near misses, and `Eq` holds (ServerConfig
    // derives `Eq`-compatible equality over `Option<WebAuthToken>`).
    let a = WebAuthToken::new("t0ken").expect("non-empty");
    assert!(a == a.clone());
    assert_eq!(a, WebAuthToken::new("t0ken").expect("non-empty"));
    assert_ne!(a, WebAuthToken::new("t0keN").expect("non-empty"));
    assert_ne!(a, WebAuthToken::new("t0ken0").expect("non-empty"));
    assert_ne!(a, WebAuthToken::new("t0ke").expect("non-empty"));
}

#[test]
fn accepts_exact_match_only() {
    let auth = WebAuth::new(WebAuthToken::new("t0ken").expect("non-empty"));
    assert!(auth.accepts("t0ken"));
    assert!(!auth.accepts("WRONG"));
    assert!(!auth.accepts(""));
    // Length-mismatched and prefix probes must not match.
    assert!(!auth.accepts("t0ken-plus-extra"));
    assert!(!auth.accepts("t0k"));
}

#[test]
fn resolve_configured_token_gates_even_on_loopback() {
    let dir = TempDir::new("configured");
    let resolution = resolve(
        Some(BindMode::Localhost),
        WebAuthToken::new("explicit"),
        &dir.0,
    )
    .expect("resolve");
    match resolution {
        WebAuthResolution::Gated { auth, origin } => {
            assert!(matches!(origin, WebAuthOrigin::Configured));
            assert!(auth.accepts("explicit"));
            assert!(!auth.accepts("other"));
        }
        WebAuthResolution::Ungated => panic!("configured token must gate"),
    }
    // The token file is never touched for a configured token.
    assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
}

#[test]
fn resolve_loopback_without_token_is_ungated_and_file_free() {
    let dir = TempDir::new("loopback");
    let resolution = resolve(Some(BindMode::Localhost), None, &dir.0).expect("resolve");
    assert!(
        matches!(resolution, WebAuthResolution::Ungated),
        "loopback without a configured token must stay ungated"
    );
    // Frozen contract: the token file is not even read/created.
    assert!(!dir.0.join(WEB_AUTH_TOKEN_FILE).exists());
}

#[test]
fn resolve_public_bind_generates_then_loads_same_token() {
    let dir = TempDir::new("generated");
    let first = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
    let WebAuthResolution::Gated {
        auth: first_auth,
        origin: WebAuthOrigin::Generated(path),
    } = first
    else {
        panic!("first public boot must generate")
    };
    assert_eq!(path, dir.0.join(WEB_AUTH_TOKEN_FILE));
    // Persisted contents match the live token.
    let on_disk = std::fs::read_to_string(&path).expect("token file exists");
    assert!(
        first_auth.accepts(on_disk.trim()),
        "persisted token must match the live one"
    );
    // Unix: owner-only permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "token file must be 0600, got {mode:o}");
    }
    // Second boot loads the SAME token (no regeneration).
    let second = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
    let WebAuthResolution::Gated {
        auth: second_auth,
        origin: WebAuthOrigin::Loaded(_),
    } = second
    else {
        panic!("second public boot must load")
    };
    assert!(second_auth.accepts(on_disk.trim()));
}

#[test]
fn resolve_public_bind_rejects_empty_token_file() {
    let dir = TempDir::new("empty-file");
    std::fs::write(dir.0.join(WEB_AUTH_TOKEN_FILE), "  \n").expect("write empty file");
    let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
    assert!(err.contains("empty"), "error must name the cause: {err}");
    assert!(
        err.contains(WEB_AUTH_TOKEN_FILE),
        "error must name the file: {err}"
    );
}

#[test]
fn resolve_public_bind_rejects_unreadable_token_file() {
    // A directory at the token-file path fails `read_to_string` on every
    // platform, regardless of the test user's privileges (root bypasses
    // permission bits, so chmod-based unreadable fixtures are unreliable).
    let dir = TempDir::new("unreadable-file");
    std::fs::create_dir(dir.0.join(WEB_AUTH_TOKEN_FILE)).expect("mkdir at token path");
    let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
    assert!(
        err.contains("failed to read"),
        "error must name the cause: {err}"
    );
}

/// A symlink at the token path must NEVER be followed — even when it
/// points at a perfectly valid token file. The no-follow open fails the
/// resolution (fail closed) with a message naming the symlink.
#[cfg(unix)]
#[test]
fn resolve_public_bind_rejects_symlink_token_file() {
    let dir = TempDir::new("symlink");
    let target = dir.0.join("real-token");
    std::fs::write(&target, "real-token").expect("write target");
    std::os::unix::fs::symlink(&target, dir.0.join(WEB_AUTH_TOKEN_FILE)).expect("create symlink");
    let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
    assert!(
        err.contains("symlink"),
        "error must name the symlink refusal: {err}"
    );
}

/// A token file readable by group/other principals exposes the bearer
/// token to other local accounts — the loader must refuse it (fail
/// closed) and name the remediation.
#[cfg(unix)]
#[test]
fn resolve_public_bind_rejects_group_or_world_readable_token_file() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = TempDir::new("loose-mode");
    let path = dir.0.join(WEB_AUTH_TOKEN_FILE);
    std::fs::write(&path, "t0ken").expect("write token file");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod 0644");
    let err = resolve(Some(BindMode::All), None, &dir.0).unwrap_err();
    assert!(
        err.contains("owner-protected"),
        "error must name the owner-protection failure: {err}"
    );
    assert!(
        err.contains("chmod 600"),
        "error must name the remediation: {err}"
    );
    // Owner-only mode is accepted (the persist path creates 0600).
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod 0600");
    let resolution = resolve(Some(BindMode::All), None, &dir.0).expect("resolve");
    assert!(
        matches!(
            resolution,
            WebAuthResolution::Gated {
                origin: WebAuthOrigin::Loaded(_),
                ..
            }
        ),
        "0600 token file must load"
    );
}

/// The race-adoption path (`AlreadyExists` from persist) goes through the
/// SAME secure loader: a symlink swapped in between the failed persist
/// and the adoption read is still refused.
#[cfg(unix)]
#[test]
fn load_token_file_refuses_symlink_directly() {
    let dir = TempDir::new("loader-symlink");
    let target = dir.0.join("real-token");
    std::fs::write(&target, "real-token").expect("write target");
    let link = dir.0.join(WEB_AUTH_TOKEN_FILE);
    std::os::unix::fs::symlink(&target, &link).expect("create symlink");
    let err = load_token_file(&link).unwrap_err();
    assert!(
        err.to_string().contains("symlink"),
        "loader must name the symlink refusal: {err}"
    );
}

#[test]
fn resolve_public_bind_fails_closed_when_state_dir_unwritable() {
    // A regular FILE at the state-dir path makes `create_dir_all` fail on
    // every platform, regardless of privileges (root bypasses permission
    // bits, so a chmod-based read-only dir is unreliable).
    let dir = TempDir::new("fail-closed");
    let state_dir = dir.0.join("state-is-a-file");
    std::fs::write(&state_dir, "not a directory").expect("write file");
    let err = resolve(Some(BindMode::All), None, &state_dir).unwrap_err();
    assert!(
        err.contains("cannot create state dir"),
        "error must name the cause: {err}"
    );
    assert!(
        err.contains("--web-auth-token"),
        "error must name the remediation: {err}"
    );
}

#[test]
fn generated_tokens_are_unique_and_url_safe() {
    let a = generate_token().expect("generate");
    let b = generate_token().expect("generate");
    assert_ne!(a.as_str(), b.as_str(), "CSPRNG tokens must differ");
    assert_eq!(a.as_str().len(), 64);
    assert!(
        a.as_str().chars().all(|c| c.is_ascii_hexdigit()),
        "hex tokens need no URL encoding for the #token= fragment"
    );
}

/// Windows: the token file must be created with its owner-only DACL in
/// place from the first byte (CreateFileW + SECURITY_ATTRIBUTES), and a
/// second create must report `AlreadyExists` so `resolve` can adopt the
/// winner of a first-boot race.
#[cfg(windows)]
#[test]
fn create_owner_only_file_applies_dacl_at_creation() {
    let dir = TempDir::new("create-owner-only");
    let path = dir.0.join(WEB_AUTH_TOKEN_FILE);
    let token = WebAuthToken::new("t0ken").expect("non-empty");
    persist_token(&path, &token).expect("first create");
    let on_disk = std::fs::read_to_string(&path).expect("token file exists");
    assert_eq!(on_disk.trim(), "t0ken");
    let err = persist_token(&path, &token).expect_err("second create must fail");
    assert_eq!(
        err.kind(),
        std::io::ErrorKind::AlreadyExists,
        "CREATE_NEW must map an existing file to AlreadyExists: {err}"
    );
}
