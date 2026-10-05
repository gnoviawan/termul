use super::*;
#[test]
fn extract_quoted() {
    let h = r#"Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource""#;
    assert_eq!(
        extract_resource_metadata_url(h),
        Some("https://x.test/.well-known/oauth-protected-resource".into())
    );
}
#[test]
fn extract_missing() {
    assert!(extract_resource_metadata_url("Bearer realm=\"t\"").is_none());
}
#[test]
fn auth_required() {
    assert!(is_auth_required(r#"Bearer resource_metadata="https://x""#));
    assert!(is_auth_required(r#"Bearer error="invalid_token""#));
    assert!(!is_auth_required("Basic realm=\"t\""));
    assert!(!is_auth_required(""));
}
#[test]
fn key_normalizes() {
    assert_eq!(
        keychain_key("https://x/mcp"),
        keychain_key("https://x/mcp/")
    );
}
#[test]
fn expiry() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: Some(now - 1),
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
    assert!(!is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: Some(now + 3600),
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
    assert!(!is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: None,
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
}

#[test]
fn token_file_path_normalizes_trailing_slash() {
    // Equivalent URLs (differing only by a trailing slash) MUST produce
    // the same token file path so a probe and a connect that differ only
    // by the trailing slash reuse the same stored token.
    let a = token_file_path("https://x/mcp").unwrap();
    let b = token_file_path("https://x/mcp/").unwrap();
    assert_eq!(a, b, "trailing slash must normalize to the same file");
}

#[test]
fn expired_token_with_refresh_is_treatable_as_expired() {
    // A token that is already expired and has a refresh_token must be
    // reported as expired so `get_valid_token` attempts a refresh. This
    // is the precondition for the refresh path being reachable at all.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let expired = StoredToken {
        access_token: "x".into(),
        refresh_token: Some("r".into()),
        expires_at: Some(now - 1),
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into(),
    };
    assert!(is_token_expired(&expired));
}
