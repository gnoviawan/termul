use super::*;

fn lookup_from(map: &HashMap<String, String>) -> impl Fn(&str) -> Option<String> + '_ {
    move |name: &str| map.get(name).cloned()
}

#[test]
fn expands_bare_and_braced_references() {
    let mut env = HashMap::new();
    env.insert("FOO".to_string(), "bar".to_string());
    env.insert("PATH".to_string(), "/bin".to_string());
    let expand = |v: &str| expand_env_with(v, lookup_from(&env));

    assert_eq!(expand("$FOO"), "bar");
    assert_eq!(expand("${FOO}"), "bar");
    assert_eq!(expand("prefix:$FOO:suffix"), "prefix:bar:suffix");
    // Literal `/` between `$FOO` (bar) and `$PATH` (/bin) yields a double
    // slash — matching POSIX shell behavior (`echo "$FOO/$PATH"` → bar//bin).
    assert_eq!(expand("$FOO/$PATH"), "bar//bin");
    assert_eq!(expand("${FOO}-${PATH}"), "bar-/bin");
    // Unset → empty string (POSIX shell behavior).
    assert_eq!(expand("$NOPE"), "");
    assert_eq!(expand("${NOPE}"), "");
    assert_eq!(expand("x=$NOPE:y"), "x=:y");
    // Lone $ and non-variable characters emitted literally.
    assert_eq!(expand("cost is $5"), "cost is $5");
    assert_eq!(expand("100%"), "100%");
    // Adjacent references and trailing text.
    assert_eq!(expand("$FOO$PATH"), "bar/bin");
    assert_eq!(expand("$FOO tail"), "bar tail");
    // Unterminated `${` is left literally (no expansion, no panic).
    assert_eq!(expand("a${UNCLOSED"), "a${UNCLOSED");
    // Empty input.
    assert_eq!(expand(""), "");
}

#[test]
fn rejects_unsupported_transport() {
    // The config is loose enough to accept any `type`; the probe rejects
    // unknown transports with a disconnected result (no panic).
    let config = McpServerConfig {
        r#type: Some("ftp".to_string()),
        name: "bad".to_string(),
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    };
    let rt = tokio::runtime::Runtime::new().unwrap();
    let result = rt.block_on(probe(config));
    assert_eq!(result.status, ProbeStatus::Disconnected);
    assert!(result.error.unwrap().contains("unsupported transport"));
}

#[tokio::test]
async fn unreachable_stdio_command_returns_disconnected() {
    // A command path that cannot exist → spawn fails → disconnected. The
    // error must NOT echo env values (none here, but the contract holds).
    let config = McpServerConfig {
        r#type: Some("stdio".to_string()),
        name: "ghost".to_string(),
        command: Some("this-binary-does-not-exist-12345".to_string()),
        args: Vec::new(),
        env: vec![McpNameValuePair {
            name: "SECRET".to_string(),
            value: "$DO_NOT_LEAK".to_string(),
        }],
        url: None,
        headers: Vec::new(),
    };
    let result = probe(config).await;
    assert_eq!(result.status, ProbeStatus::Disconnected);
    let error = result.error.expect("disconnected carries an error");
    assert!(
        !error.contains("DO_NOT_LEAK"),
        "error must not leak env value references: {error}"
    );
    assert!(error.contains("spawn failed"));
    assert!(result.tools.is_empty());
}

#[tokio::test]
async fn missing_stdio_command_returns_disconnected() {
    let config = McpServerConfig {
        r#type: Some("stdio".to_string()),
        name: "empty".to_string(),
        command: Some("   ".to_string()),
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    };
    let result = probe(config).await;
    assert_eq!(result.status, ProbeStatus::Disconnected);
    assert!(result.error.unwrap().contains("command is required"));
}

#[cfg(target_os = "windows")]
#[test]
fn resolve_stdio_command_rewrites_windows_cmd_shim() {
    // Simulate an npm-installed launcher (e.g. `npx`) that exists only as a
    // `.cmd` shim — `CreateProcessW` cannot launch batch files directly, so
    // the resolver must rewrite it to the directly-executable interpreter
    // with the script prepended ahead of the user args.
    // Unique per-process dir so parallel `cargo test` invocations cannot
    // delete/overwrite each other's fixtures.
    let dir = std::env::temp_dir().join(format!("termul-test-mcp-cmd-shim-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    std::fs::create_dir_all(dir.join("node_modules\\npx\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\npx\\bin\\npx"), b"").unwrap();

    let shim_path = dir.join("npx.cmd");
    let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\npx\\bin\\npx\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    let (program, prepend_args) = resolve_stdio_command(&shim_path.to_string_lossy());
    assert!(
        program.ends_with("node.exe"),
        "expected node.exe, got: {program}"
    );
    assert_eq!(prepend_args.len(), 1);
    assert!(
        prepend_args[0].contains("node_modules\\npx\\bin\\npx"),
        "expected npx script first, got: {:?}",
        prepend_args
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unreachable_http_url_returns_disconnected() {
    // A port nothing listens on → connect failure → disconnected. The error
    // must not leak header values.
    let config = McpServerConfig {
        r#type: Some("http".to_string()),
        name: "dead".to_string(),
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: Some("http://127.0.0.1:1/mcp".to_string()),
        headers: vec![McpNameValuePair {
            name: "Authorization".to_string(),
            value: "Bearer super-secret".to_string(),
        }],
    };
    let result = probe(config).await;
    assert_eq!(result.status, ProbeStatus::Disconnected);
    let error = result.error.expect("disconnected carries an error");
    assert!(
        !error.contains("super-secret"),
        "error must not leak header values: {error}"
    );
    assert!(result.tools.is_empty());
}
