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

#[cfg(unix)]
#[tokio::test]
async fn concurrent_identical_probes_share_one_spawn() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spawn_log = dir.path().join("spawns");
    let config = || McpServerConfig {
        r#type: Some("stdio".to_string()),
        name: "spawn-counter".to_string(),
        command: Some("sh".to_string()),
        args: vec![
            "-c".to_string(),
            format!("echo spawn >> '{}'; sleep 1", spawn_log.display()),
        ],
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    };
    let spawns = || {
        std::fs::read_to_string(&spawn_log)
            .unwrap_or_default()
            .lines()
            .count()
    };

    let (first, second) = tokio::join!(probe(config()), probe(config()));
    assert_eq!(first.status, ProbeStatus::Disconnected);
    assert_eq!(second.status, ProbeStatus::Disconnected);
    assert_eq!(first.error, second.error);
    assert_eq!(spawns(), 1);

    probe(config()).await;
    assert_eq!(spawns(), 2, "a finished probe is not cached");
}

/// Serves `POST /mcp` with a slow OAuth challenge and counts the requests.
async fn serve_slow_oauth_challenge() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let app = axum::Router::new().route(
        "/mcp",
        axum::routing::post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(500)).await;
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    [(
                        axum::http::header::WWW_AUTHENTICATE,
                        r#"Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource""#,
                    )],
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (url, requests)
}

#[tokio::test]
async fn probe_started_before_a_token_change_is_not_joined() {
    use std::sync::atomic::Ordering;
    let (url, requests) = serve_slow_oauth_challenge().await;
    let config = || McpServerConfig {
        r#type: Some("http".to_string()),
        name: "oauth-server".to_string(),
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: Some(url.clone()),
        headers: Vec::new(),
    };

    let (first, second) = tokio::join!(probe(config()), probe(config()));
    assert_eq!(first.status, ProbeStatus::AuthRequired);
    assert_eq!(second.status, ProbeStatus::AuthRequired);
    assert_eq!(requests.load(Ordering::SeqCst), 1);

    let stale = tokio::spawn(probe(config()));
    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the stale probe reached the server");
    crate::acp::mcp_oauth::delete_stored_token(&url).expect("disconnect");
    let fresh = probe(config()).await;
    let stale = stale.await.unwrap();

    assert_eq!(stale.status, ProbeStatus::AuthRequired);
    assert_eq!(fresh.status, ProbeStatus::AuthRequired);
    assert_eq!(requests.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn panicking_probe_task_leaves_no_in_flight_entry() {
    let config = McpServerConfig {
        r#type: Some("stdio".to_string()),
        name: "panicking-probe".to_string(),
        command: Some("unused".to_string()),
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    };
    let stale = futures::future::ready(ProbeResult::disconnected("stale"))
        .boxed()
        .shared();
    let key = (config, 0);
    IN_FLIGHT_PROBES.lock().insert(key.clone(), stale);

    let entry = key.clone();
    let joined = tokio::spawn(async move {
        let _entry = InFlightEntry(entry);
        panic!("probe panicked");
    })
    .await;

    assert!(joined.unwrap_err().is_panic());
    assert!(!IN_FLIGHT_PROBES.lock().contains_key(&key));
}

/// Probes a local server that records every `Authorization` value it gets,
/// with a stored OAuth token and the given configured `Authorization` value.
async fn authorization_values_sent(configured: &str) -> Vec<String> {
    use std::sync::Arc;
    let seen: Arc<parking_lot::Mutex<Vec<String>>> = Arc::default();
    let recorder = seen.clone();
    let app = axum::Router::new().route(
        "/mcp",
        axum::routing::post(move |headers: axum::http::HeaderMap| {
            let recorder = recorder.clone();
            async move {
                recorder.lock().extend(
                    headers
                        .get_all(axum::http::header::AUTHORIZATION)
                        .iter()
                        .map(|value| value.to_str().unwrap_or_default().to_string()),
                );
                axum::http::StatusCode::UNAUTHORIZED
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    crate::acp::mcp_oauth::store_token(
        &url,
        &crate::acp::mcp_oauth::StoredToken {
            access_token: "oauth-access".into(),
            refresh_token: None,
            expires_at: None,
            client_id: "termul-client".into(),
            issuer: url.clone(),
            server_url: url.clone(),
        },
    )
    .unwrap();

    probe(McpServerConfig {
        r#type: Some("http".to_string()),
        name: "api-key-server".to_string(),
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: Some(url.clone()),
        headers: vec![McpNameValuePair {
            name: "Authorization".to_string(),
            value: configured.to_string(),
        }],
    })
    .await;
    crate::acp::mcp_oauth::delete_stored_token(&url).unwrap();
    let seen = seen.lock().clone();
    seen
}

/// A configured `Authorization` header wins over a stored OAuth token, the
/// same rule the chat path applies in `inject_oauth_tokens`.
#[tokio::test]
async fn configured_authorization_header_is_sent_instead_of_the_stored_token() {
    let seen = authorization_values_sent("Bearer api-key").await;
    assert!(!seen.is_empty(), "the probe reached the server");
    assert!(
        seen.iter().all(|value| value == "Bearer api-key"),
        "only the configured header is sent: {seen:?}"
    );
}

/// A configured `Authorization` value that is not a valid header value is
/// dropped before sending, so the stored OAuth token is used instead.
#[tokio::test]
async fn malformed_configured_authorization_falls_back_to_the_stored_token() {
    let seen = authorization_values_sent("Bearer api-key\n").await;
    assert!(!seen.is_empty(), "the probe reached the server");
    assert!(
        seen.iter().all(|value| value == "Bearer oauth-access"),
        "the stored token is sent: {seen:?}"
    );
}

#[test]
fn a_listed_tool_keeps_its_input_schema_on_the_wire() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": { "labels": { "type": "array", "items": { "type": "string" } } },
        "required": ["labels"]
    });
    let serde_json::Value::Object(object) = schema.clone() else {
        unreachable!("the schema literal is an object")
    };
    let info = tool_info(rmcp::model::Tool::new("add_labels", "Add labels", object));
    assert_eq!(
        serde_json::to_value(&info).unwrap(),
        serde_json::json!({
            "name": "add_labels",
            "description": "Add labels",
            "inputSchema": schema
        })
    );
}
