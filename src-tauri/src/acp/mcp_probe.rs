//! On-demand MCP client probe.
//!
//! Opens a fresh rmcp client connection to a configured MCP server, completes
//! the `initialize` handshake, calls `tools/list`, then closes — and reports
//! the connected/disconnected status plus the tool list. The probe is
//! **on-demand only**: each invocation opens a brand-new connection and tears
//! it down immediately after `tools/list` returns (or fails). There are no
//! persistent always-on connections.
//!
//! The probe is stateless: it takes a renderer-supplied [`McpServerConfig`] and
//! does NOT touch the persisted registry. This mirrors `acp_probe_runtime`
//! (stateless Tauri command) — the renderer already holds the full config and
//! passes it through.
//!
//! ## Transport mapping
//!
//! - `stdio` → rmcp `transport-child-process` (`TokioChildProcess`). On Windows
//!   the child is spawned with `CREATE_NO_WINDOW` (`0x0800_0000`) so a GUI-launched
//!   probe does not flash a console window (mirrors the vendored ACP patch in
//!   `vendor/agent-client-protocol/src/acp_agent.rs`).
//! - `http` → rmcp `transport-streamable-http-client-reqwest`
//!   (`StreamableHttpClientTransport`).
//! - `sse` → rmcp 1.7.0 removed the standalone legacy SSE transport
//!   (CHANGELOG #562). The `client-side-sse` feature ships the SSE stream
//!   parser consumed by the streamable-http client (which still speaks
//!   `text/event-stream`). `type: 'sse'` servers are therefore probed via the
//!   modern streamable-http client; pure-legacy SSE-only servers may not probe
//!   correctly. This is a known residual risk — see the spec's Design Notes.
//!
//! Env values in stdio configs are `$VAR`/`${VAR}`-expanded before spawn
//! (unset variable → empty string, matching shell behavior). Header values are
//! NOT expanded (headers are HTTP-only; shell expansion does not apply).
//!
//! Probe outcomes are logged (connected/disconnected + server name + transport)
//! WITHOUT env/header values, tokens, or credentials.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use rmcp::model::ClientInfo;
use rmcp::service::{serve_client, RunningService};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Probe deadline. A hanging server (dead URL, blocking stdio) must not pin
/// the probe forever — cap the whole initialize + tools/list round-trip.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// A name=value pair (env var or HTTP header) as the renderer serializes it.
/// Mirrors `McpEnvVar` / `McpHeader` in `src/renderer/lib/acp-api.ts`.
///
/// `Debug` is implemented manually to redact `value` (env values and HTTP
/// header values frequently carry secrets). A derived `Debug` would print the
/// raw value to any tracing/log macro that formats the struct — defense-in-
/// depth so a future `?`/`%` log call cannot leak credentials.
#[derive(Clone, Deserialize)]
pub struct McpNameValuePair {
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for McpNameValuePair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpNameValuePair")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish()
    }
}

/// Renderer-supplied MCP server config. Stateless payload — the renderer holds
/// the full config (including `id`/`enabled`) and passes the wire subset here.
/// `type` defaults to `"stdio"` when omitted (mirrors `transportOf`).
///
/// Kept deliberately loose (all transport-specific fields optional) so the
/// probe does not couple to the vendored ACP `McpServer` schema — the probe
/// owns its own deserialization and never touches the registry store.
///
/// `Debug` is implemented manually to redact `env` and `headers` (whose `value`
/// fields carry secrets — see `McpNameValuePair`). Identifying fields the
/// boundary log already surfaces (`name`/`command`/`url`/`type`/`args`) stay
/// visible for diagnostics.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    #[serde(default, rename = "type")]
    pub r#type: Option<String>,
    pub name: String,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpNameValuePair>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<McpNameValuePair>,
}

impl std::fmt::Debug for McpServerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServerConfig")
            .field("type", &self.r#type)
            .field("name", &self.name)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("env", &format!("<{} redacted>", self.env.len()))
            .field("url", &self.url)
            .field("headers", &format!("<{} redacted>", self.headers.len()))
            .finish()
    }
}

impl McpServerConfig {
    fn transport(&self) -> String {
        self.r#type.clone().unwrap_or_else(|| "stdio".to_string())
    }
}

/// A tool exposed by the probed server (`tools/list` output, trimmed to the
/// fields the UI surfaces).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum ProbeStatus {
    #[serde(rename = "connected")]
    Connected,
    #[serde(rename = "disconnected")]
    Disconnected,
    /// The server requires OAuth authentication. The renderer should show a
    /// "Connect" button that starts the OAuth flow (see `mcp_oauth.rs`).
    #[serde(rename = "authRequired")]
    AuthRequired,
}

/// Probe result. On `Disconnected`, `error` carries a short, value-free message
/// (no env/header values, tokens, or credentials). On `AuthRequired`, the
/// `www_authenticate_header` carries the raw header so the renderer can
/// extract the `resource_metadata` URL and start the OAuth flow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub status: ProbeStatus,
    #[serde(default)]
    pub tools: Vec<McpToolInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Present only when `status == AuthRequired`. The raw `WWW-Authenticate`
    /// header value from the `401` response (never carries tokens/credentials —
    /// it's the challenge, not the credential).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub www_authenticate_header: Option<String>,
}

impl ProbeResult {
    fn connected(tools: Vec<McpToolInfo>) -> Self {
        Self {
            status: ProbeStatus::Connected,
            tools,
            error: None,
            www_authenticate_header: None,
        }
    }

    fn disconnected(error: impl Into<String>) -> Self {
        Self {
            status: ProbeStatus::Disconnected,
            tools: Vec::new(),
            error: Some(error.into()),
            www_authenticate_header: None,
        }
    }

    fn auth_required(www_authenticate_header: String) -> Self {
        Self {
            status: ProbeStatus::AuthRequired,
            tools: Vec::new(),
            error: None,
            www_authenticate_header: Some(www_authenticate_header),
        }
    }
}

/// Expand `$VAR` and `${VAR}` references in `value` against the process
/// environment. Unset variables expand to the empty string (matching POSIX
/// shell behavior). Non-UTF8 env values are skipped.
///
/// There is no existing cross-platform expander in the tree
/// (`pty/env_refresh.rs` is Windows-only and private), so this small helper
/// owns the behavior. It is `pub(crate)` so the test module can exercise it.
pub(crate) fn expand_env(value: &str) -> String {
    expand_env_with(value, |name| std::env::var(name).ok())
}

/// Testable core: `lookup` provides the variable map (the real expander uses
/// `std::env::var`; tests inject a fake map). Unset → `None` → empty string.
fn expand_env_with(value: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while !rest.is_empty() {
        match rest.find('$') {
            None => {
                out.push_str(rest);
                break;
            }
            Some(dollar) => {
                out.push_str(&rest[..dollar]);
                let after = &rest[dollar + 1..];
                // `${VAR}` braced form.
                if let Some(stripped) = after.strip_prefix('{') {
                    match stripped.find('}') {
                        Some(end) => {
                            let name = &stripped[..end];
                            out.push_str(&lookup(name).unwrap_or_default());
                            rest = &stripped[end + 1..];
                        }
                        None => {
                            // Unterminated `${` — treat literally (no expansion).
                            out.push('$');
                            out.push_str(after);
                            break;
                        }
                    }
                } else {
                    // `$VAR` bare form: [A-Za-z_][A-Za-z0-9_]*.
                    let end = after
                        .char_indices()
                        .take_while(|(i, c)| {
                            let first = *i == 0;
                            c.is_ascii_alphabetic()
                                || (c == &'_')
                                || (!first && c.is_ascii_digit())
                        })
                        .last()
                        .map(|(i, c)| i + c.len_utf8())
                        .unwrap_or(0);
                    if end == 0 {
                        // Lone `$` not followed by a valid name — emit literally.
                        out.push('$');
                        rest = after;
                    } else {
                        let name = &after[..end];
                        out.push_str(&lookup(name).unwrap_or_default());
                        rest = &after[end..];
                    }
                }
            }
        }
    }
    out
}

/// One-shot probe: open a fresh rmcp client connection, `initialize`, list
/// tools, close. Never panics, never logs secrets — only the server name +
/// transport + outcome.
pub async fn probe(server: McpServerConfig) -> ProbeResult {
    let transport = server.transport();
    let name = server.name.clone();
    let result = tokio::time::timeout(PROBE_TIMEOUT, probe_inner(&server)).await;
    let outcome = match result {
        Ok(inner) => inner,
        Err(_elapsed) => ProbeResult::disconnected(format!(
            "probe timed out after {}s",
            PROBE_TIMEOUT.as_secs()
        )),
    };
    // Boundary log: outcome + server name + transport. NO env/header values,
    // tokens, or credentials.
    match outcome.status {
        ProbeStatus::Connected => tracing::info!(
            server = %name,
            transport = %transport,
            tools = outcome.tools.len(),
            "MCP probe connected"
        ),
        ProbeStatus::Disconnected => tracing::warn!(
            server = %name,
            transport = %transport,
            "MCP probe disconnected"
        ),
        ProbeStatus::AuthRequired => tracing::info!(
            server = %name,
            transport = %transport,
            "MCP probe: server requires OAuth authentication"
        ),
    }
    outcome
}

async fn probe_inner(server: &McpServerConfig) -> ProbeResult {
    let transport = server.transport();
    match transport.as_str() {
        "stdio" => probe_stdio(server).await,
        "http" | "sse" => probe_http(server, &transport).await,
        other => ProbeResult::disconnected(format!("unsupported transport '{other}'")),
    }
}

/// Resolve a stdio command for direct spawning (Windows shim handling).
///
/// On Windows, npm/PowerShell CLIs install as `.cmd`/`.bat` batch shims, which
/// `CreateProcessW` cannot launch directly (os error 193 / "spawn failed").
/// Reuse the PTY launcher's shim-aware resolver (ADR-004.2): it rewrites e.g.
/// `npx.cmd` to `node.exe <script>`, prepending the script ahead of the user
/// args. A resolution failure falls back to the legacy PATH/PATHEXT lookup so
/// any real spawn error stays observable. On non-Windows the bare command name
/// is returned unchanged (PATH resolution is left to the spawner).
fn resolve_stdio_command(command: &str) -> (String, Vec<String>) {
    match crate::pty::manager::resolve_spawn_program(command) {
        Ok(resolved) => (resolved.program, resolved.prepend_args),
        Err(_) => (
            crate::trackers::git_tracker::resolve_executable(command),
            Vec::new(),
        ),
    }
}

async fn probe_stdio(server: &McpServerConfig) -> ProbeResult {
    let command = match server.command.as_deref() {
        Some(c) if !c.trim().is_empty() => c,
        _ => return ProbeResult::disconnected("stdio command is required"),
    };
    let (program, prepend_args) = resolve_stdio_command(command);
    let mut cmd = Command::new(&program);
    cmd.args(&prepend_args);
    cmd.args(&server.args);
    for pair in &server.env {
      // Expand `$VAR`/`${VAR}` before spawn; unset → empty string.
      cmd.env(&pair.name, expand_env(&pair.value));
    }
    // Windows: suppress the console window a GUI-launched probe would flash.
    // CREATE_NO_WINDOW = 0x0800_0000 (mirrors the vendored ACP patch). tokio's
    // `Command` exposes `creation_flags` natively on Windows.
    #[cfg(target_os = "windows")]
    {
      cmd.creation_flags(0x0800_0000);
    }
    // Kill the child if the probe future is dropped mid-flight (notably when
    // `tokio::time::timeout` fires above — dropping `probe_inner` drops the
    // `TokioChildProcess` handle; without `kill_on_drop` the child is left
    // running as an orphan). HTTP/SSE transports have no child process and are
    // unaffected. tokio's default is to leave the child running on drop.
    cmd.kill_on_drop(true);

    // Builder lets us null stderr so a chatty child does not pollute our logs.
    // stdin/stdout stay piped (the rmcp transport owns them).
    let spawn = TokioChildProcess::builder(cmd)
        .stderr(Stdio::null())
        .spawn();
    let transport = match spawn {
        Ok((proc, _stderr)) => proc,
        Err(error) => return ProbeResult::disconnected(format!("spawn failed: {error}")),
    };
    let running = match serve_client(ClientInfo::default(), transport).await {
        Ok(service) => service,
        Err(error) => return ProbeResult::disconnected(format!("initialize failed: {error}")),
    };
    drive_running(running).await
}

async fn probe_http(server: &McpServerConfig, transport: &str) -> ProbeResult {
    let url = match server.url.as_deref() {
        Some(u) if !u.trim().is_empty() => u,
        _ => return ProbeResult::disconnected(format!("{transport} URL is required")),
    };
    let mut config = StreamableHttpClientTransportConfig::with_uri(url);
    if !server.headers.is_empty() {
        let mut headers = HashMap::new();
        for pair in &server.headers {
            // reqwest re-exports `http::HeaderName`/`HeaderValue` (the project
            // already depends on reqwest); avoids a direct `http` dep here.
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(pair.name.as_bytes()),
                reqwest::header::HeaderValue::from_str(&pair.value),
            ) {
                headers.insert(name, value);
            } else {
                // Skip a malformed header — do NOT surface the value.
                tracing::warn!(
                    server = %server.name,
                    transport,
                    "skipping malformed MCP header (value redacted)"
                );
            }
        }
        config = config.custom_headers(headers);
    }
    // If the server has a stored OAuth token, inject it as a Bearer auth
    // header so the probe succeeds without re-prompting. This is the
    // "connect once, use forever" path — after the OAuth flow completes and
    // the token is persisted, every subsequent probe loads and uses it.
    let stored_token = match crate::acp::mcp_oauth::get_valid_token(url).await {
        Ok(token) => token,
        Err(e) => {
            tracing::warn!(
                server = %server.name,
                transport,
                "MCP probe: token lookup failed (url redacted): {e}"
            );
            None
        }
    };
    if let Some(ref token) = stored_token {
        config = config.auth_header(crate::acp::mcp_oauth::bearer_header(token));
    }

    // Pre-flight: check for OAuth requirement ONLY when we don't have a
    // stored token. If we have a token, skip the pre-flight (it would send
    // an unauthenticated request, get 401, and wrongly return authRequired).
    if stored_token.is_none() {
        // Forward the server's configured headers so a server that requires
        // an API-key or tenant header (and returns a Bearer challenge when
        // it is absent) is not misdetected as needing OAuth.
        if let Some(www_auth_header) = check_oauth_required(url, &server.headers).await {
            if crate::acp::mcp_oauth::is_auth_required(&www_auth_header) {
                tracing::info!(
                    server = %server.name,
                    transport,
                    "MCP probe: server requires OAuth authentication"
                );
                return ProbeResult::auth_required(www_auth_header);
            }
        }
    }

    let client = StreamableHttpClientTransport::from_config(config);
    let running = match serve_client(ClientInfo::default(), client).await {
        Ok(service) => service,
        Err(error) => {
            // Fallback: if the pre-flight didn't catch it but serve_client
            // still reports "Auth required", detect it here. This catches
            // servers that respond differently to the pre-flight POST vs the
            // rmcp client's initialize handshake.
            let error_str = error.to_string();
            if error_str.to_lowercase().contains("auth required")
                || error_str.contains("AuthRequired")
            {
                // We don't have the WWW-Authenticate header here, but the
                // renderer can still show a Connect button. The OAuth flow
                // will discover the resource_metadata URL from the server.
                tracing::info!(
                    server = %server.name,
                    transport,
                    "MCP probe: server requires OAuth (detected from serve_client error)"
                );
                return ProbeResult::auth_required(String::new());
            }
            return ProbeResult::disconnected(format!("initialize failed: {error}"));
        }
    };
    drive_running(running).await
}

/// Pre-flight check: send a raw HTTP request to the MCP server URL and check
/// for a `401` response with a `WWW-Authenticate: Bearer` header. Returns the
/// header value if the server requires OAuth, or `None` if the server is
/// reachable without auth (or unreachable for non-auth reasons). This avoids
/// the rmcp worker swallowing the `AuthRequired` error into a generic
/// "Transport channel closed".
async fn check_oauth_required(url: &str, headers: &[McpNameValuePair]) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    // Send an empty JSON-RPC initialize request — the server will respond
    // with 401 if OAuth is required before any protocol negotiation.
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": 0,
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "termul-probe", "version": "0.1" }
        }
    });
    let mut request = client.post(url).json(&body);
    // Forward configured headers so the pre-flight matches what the real
    // rmcp client would send (a server may return a Bearer challenge only
    // when an API-key header is absent — sending it avoids a false
    // authRequired).
    for pair in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(pair.name.as_bytes()),
            reqwest::header::HeaderValue::from_str(&pair.value),
        ) {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.ok()?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(header) = response.headers().get(reqwest::header::WWW_AUTHENTICATE) {
            if let Ok(value) = header.to_str() {
                return Some(value.to_string());
            }
        }
    }
    None
}
/// Drive an initialized rmcp client service: list all tools (paginated), then
/// cancel (tear down the connection — the probe is one-shot). Maps the rmcp
/// `Tool` model to the trimmed `McpToolInfo` the UI surfaces.
async fn drive_running(running: RunningService<rmcp::service::RoleClient, ClientInfo>) -> ProbeResult {
    let tools = match running.list_all_tools().await {
        Ok(tools) => tools,
        Err(error) => {
            let _ = running.cancel().await;
            return ProbeResult::disconnected(format!("tools/list failed: {error}"));
        }
    };
    let mapped = tools
        .into_iter()
        .map(|tool| McpToolInfo {
            name: tool.name.to_string(),
            description: tool.description.map(|cow| cow.to_string()),
        })
        .collect();
    // Tear down the connection (one-shot probe — no persistent hold).
    let _ = running.cancel().await;
    ProbeResult::connected(mapped)
}

#[cfg(test)]
mod tests {
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
        let dir = std::env::temp_dir()
            .join(format!("termul-test-mcp-cmd-shim-{}", std::process::id()));
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
}
