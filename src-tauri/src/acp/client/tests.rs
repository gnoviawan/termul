use super::*;

#[test]
fn client_capabilities_advertise_fs_and_gate_terminal() {
    let caps = client_capabilities(true);
    assert!(caps.fs.read_text_file);
    assert!(caps.fs.write_text_file);
    assert!(caps.terminal);
    // `unstable_auth_methods` (spec-acp-terminal-auth): terminal auth is
    // always advertised so agents expose their designed headless path
    // (e.g. `devin-terminal-login`) regardless of the PTY gate.
    assert!(caps.auth.terminal);
    // Default-deny: terminal is omitted unless the agent opted in.
    let denied = client_capabilities(false);
    assert!(denied.fs.read_text_file);
    assert!(!denied.terminal);
    // Terminal-auth advertisement is independent of the PTY gate.
    assert!(denied.auth.terminal);
}

#[test]
fn client_capabilities_advertise_parameterized_model_picker_meta() {
    let caps = client_capabilities(false);
    let meta = caps.meta.expect("expected client capabilities _meta");
    assert_eq!(
        meta.get(PARAMETERIZED_MODEL_PICKER_META_KEY),
        Some(&serde_json::Value::Bool(true))
    );
}

#[tokio::test]
async fn read_text_file_rejects_relative_path() {
    let req = ReadTextFileRequest::new("sess", "relative/path.txt");
    let root = std::env::temp_dir();
    let err = handle_read_text_file(&req, Some(root.as_path()))
        .await
        .unwrap_err();
    assert_eq!(err.code, acp::ErrorCode::InvalidParams);
}

#[tokio::test]
async fn read_without_workspace_root_succeeds() {
    // An absolute path with no associated session root is now resolved
    // directly (no longer denied — the containment jail was removed by
    // spec-remove-web-fs-path-jail).
    let dir = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("file.txt");
    std::fs::write(&path, "secret").unwrap();

    let req = ReadTextFileRequest::new("sess", &path);
    let resp = handle_read_text_file(&req, None).await.unwrap();
    assert_eq!(resp.content, "secret");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn read_outside_workspace_is_allowed() {
    // A direct absolute path outside the workspace root is now allowed
    // (the containment jail was removed by spec-remove-web-fs-path-jail).
    let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    let workspace = base.join("workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();

    let req = ReadTextFileRequest::new("sess", &secret);
    let resp = handle_read_text_file(&req, Some(workspace.as_path()))
        .await
        .unwrap();
    assert_eq!(resp.content, "top secret");

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn read_rejects_traversal_sequence_in_path() {
    // `..` traversal is still rejected even though containment is removed.
    let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    let workspace = base.join("workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    std::fs::write(&secret, "top secret").unwrap();

    let escape = workspace.join("..").join("outside").join("secret.txt");
    let req = ReadTextFileRequest::new("sess", &escape);
    let err = handle_read_text_file(&req, Some(workspace.as_path()))
        .await
        .unwrap_err();
    assert_eq!(err.code, acp::ErrorCode::InvalidParams);

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn write_outside_workspace_is_allowed() {
    // A write to a path outside the workspace root is now allowed (the
    // containment jail was removed by spec-remove-web-fs-path-jail).
    let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    let workspace = base.join("workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    let target = outside.join("evil.txt");
    let req = WriteTextFileRequest::new("sess", &target, "pwned");
    handle_write_text_file(&req, Some(workspace.as_path()))
        .await
        .unwrap();
    assert!(target.exists(), "write outside workspace must succeed");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "pwned");

    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn write_then_read_roundtrips() {
    let workspace = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&workspace).unwrap();
    let path = workspace.join("nested").join("file.txt");

    let write_req = WriteTextFileRequest::new("sess", &path, "line1\nline2\nline3");
    handle_write_text_file(&write_req, Some(workspace.as_path()))
        .await
        .unwrap();

    let read_req = ReadTextFileRequest::new("sess", &path);
    let resp = handle_read_text_file(&read_req, Some(workspace.as_path()))
        .await
        .unwrap();
    assert_eq!(resp.content, "line1\nline2\nline3");

    // line/limit slicing: start at line 2, take 1 line.
    let sliced = ReadTextFileRequest::new("sess", &path)
        .line(2u32)
        .limit(1u32);
    let resp = handle_read_text_file(&sliced, Some(workspace.as_path()))
        .await
        .unwrap();
    // Slicing preserves the original terminator on the sliced line.
    assert_eq!(resp.content, "line2\n");

    let _ = std::fs::remove_dir_all(&workspace);
}

#[tokio::test]
async fn slicing_preserves_crlf_and_trailing_newline() {
    let workspace = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&workspace).unwrap();
    let path = workspace.join("crlf.txt");

    // CRLF file ending in a trailing newline.
    std::fs::write(&path, "a\r\nb\r\nc\r\n").unwrap();

    // Take all three lines starting at line 1: must be byte-identical.
    let req = ReadTextFileRequest::new("sess", &path)
        .line(1u32)
        .limit(3u32);
    let resp = handle_read_text_file(&req, Some(workspace.as_path()))
        .await
        .unwrap();
    assert_eq!(resp.content, "a\r\nb\r\nc\r\n");

    // Take the middle line: keep its CRLF terminator.
    let req = ReadTextFileRequest::new("sess", &path)
        .line(2u32)
        .limit(1u32);
    let resp = handle_read_text_file(&req, Some(workspace.as_path()))
        .await
        .unwrap();
    assert_eq!(resp.content, "b\r\n");

    let _ = std::fs::remove_dir_all(&workspace);
}
