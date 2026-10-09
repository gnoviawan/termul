//! Child side of the host-injected plan tool.
//!
//! Entered via the hidden `--internal-mcp-plan-server` subcommand (both the
//! desktop `termul-manager` and standalone `termul-server` binaries branch on
//! this flag in `main` / `server_main` BEFORE any Tauri/AppHandle setup). The
//! agent spawns `current_exe() --internal-mcp-plan-server` as the injected
//! `McpServer::Stdio`; the child inherits the agent-provided stdin/stdout (the
//! MCP stdio transport).
//!
//! The child runs an rmcp MCP SERVER over stdio exposing the `plan`
//! tool. On each `tools/call`, it opens a fresh TCP connection to the parent
//! (port + token from env), forwards the input, and returns the parent's reply
//! to the agent. Minimal runtime: no Tauri plugins, no `AppHandle`, no sinks —
//! works identically on desktop + standalone.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::service::serve_server;
use rmcp::{tool, tool_router};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::acp::host_mcp::{
    FrameKind, FrameReply, FrameRequest, TermulBrowserInput, TermulPlanInput, TermulSetTitleInput,
    ENV_AGENT_ID, ENV_PORT, ENV_SESSION_ID, ENV_TOKEN,
};

/// Env-derived configuration for the child. Extracted so the arg parser is
/// unit-testable without touching `std::env`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildConfig {
    pub port: u16,
    pub token: String,
    pub session_id: String,
    pub agent_id: String,
}

/// Parse the child's env (`TERMUL_PLAN_PORT` / `_TOKEN` / `_SESSION_ID` /
/// `_AGENT_ID`). Returns an error string (not an enum) so `run()` can print it
/// verbatim to stderr + exit 1 — matching the matrix's "child exits non-zero
/// within 5s" AC.
pub fn parse_env() -> Result<ChildConfig, String> {
    let port: u16 = std::env::var(ENV_PORT)
        .ok()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing or invalid {ENV_PORT}"))?;
    let token = std::env::var(ENV_TOKEN)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("missing {ENV_TOKEN}"))?;
    let session_id = std::env::var(ENV_SESSION_ID)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("missing {ENV_SESSION_ID}"))?;
    // AGENT_ID is optional (used only for logging in the parent); absent → "".
    let agent_id = std::env::var(ENV_AGENT_ID).unwrap_or_default();
    Ok(ChildConfig {
        port,
        token,
        session_id,
        agent_id,
    })
}

/// Subcommand entrypoint. Called from `main.rs` (desktop) / `server_main.rs`
/// (standalone) when the first arg is `--internal-mcp-plan-server`. Returns an
/// `i32` exit code so both call sites can use it (`std::process::exit` on
/// desktop, `ExitCode::from(code as u8)` on standalone). Never returns
/// normally on failure — prints an error to stderr + returns non-zero.
pub fn run() -> i32 {
    let config = match parse_env() {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("[host-mcp-child] {msg}");
            return 1;
        }
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[host-mcp-child] failed to start runtime: {e}");
            return 1;
        }
    };

    match runtime.block_on(serve_mcp_server(config)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[host-mcp-child] {e}");
            1
        }
    }
}

/// The rmcp MCP server service backing `plan`. Holds the per-session
/// connection info (port + token + session_id) so each `tools/call` can open a
/// fresh TCP connection to the parent.
struct TermulPlanServer {
    config: ChildConfig,
}

/// rmcp derives the `tools/list` entry from the `#[tool]` attribute; the input
/// type must implement `schemars::JsonSchema` so rmcp can generate the
/// `inputSchema`. We re-export the shared `TermulPlanInput` (defined in
/// `host_mcp::mod`) — it already derives `JsonSchema`.
///
/// `server_handler` on `#[tool_router]` auto-generates the `ServerHandler` impl
/// (no separate `impl ServerHandler` block needed — adding one would duplicate
/// the impl + fail to compile).
#[tool_router(server_handler)]
impl TermulPlanServer {
    #[tool(
        name = "plan",
        description = "Update the execution plan / todo list shown in the Termul plan panel. You MUST call this instead of any built-in todo/task tool — do not maintain your own todo list. Every time you would create or update a task, call this tool so the user sees a unified plan UI across all agents."
    )]
    async fn plan(&self, Parameters(input): Parameters<TermulPlanInput>) -> String {
        let request = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::Plan,
            todos: input.todos,
            title: None,
            browser_action: None,
            browser_args: None,
            browser_element: None,
        };
        match forward_to_parent(&self.config, request, "plan updated").await {
            Ok(msg) => msg,
            Err(e) => format!("plan error: {e}"),
        }
    }

    #[tool(
        name = "browser",
        description = "Control the Termul in-app browser (the pane the user can watch). Pass action parameters either FLAT at the top level (e.g. {\"action\":\"navigate\",\"url\":\"https://example.com\"}) or NESTED under \"args\" (e.g. {\"action\":\"navigate\",\"args\":{\"url\":\"https://example.com\"}}) — both forms are accepted for every documented parameter (url, ref, value, text, ms, tabId, key, dy, element); \"args\" must be a JSON object, never a string. Actions: navigate {url, tabId?}, snapshot {}, screenshot {}, click {ref, element?}, fill {ref, value, element?}, type {text, ref?}, press {key}, scroll {dy? | ref?}, hover {ref}, wait {ms | text}, new_tab {url}, list_tabs {}, close_tab {tabId?}, back/forward/reload {tabId?}. navigate without tabId reuses this session's single agent tab (auto-opening one only when the session owns none); an explicit tabId must be a tab this session owns or the call fails with tab_not_found (it never auto-opens another tab). Take a snapshot after navigation to get @eN element refs, then act on refs. Windows desktop only; other platforms report capability_unavailable."
    )]
    async fn browser(&self, Parameters(input): Parameters<TermulBrowserInput>) -> String {
        let request = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::Browser,
            todos: Vec::new(),
            title: None,
            browser_action: Some(input.action),
            browser_args: Some(input.args),
            browser_element: input.element,
        };
        match forward_to_parent_raw(&self.config, request).await {
            Ok(reply) if reply.ok => reply
                .result
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
            Ok(reply) => match reply.code {
                Some(code) => format!(
                    "browser error [{code}]: {}",
                    reply.error.unwrap_or_else(|| "unknown".to_string())
                ),
                None => format!(
                    "browser error: {}",
                    reply.error.unwrap_or_else(|| "unknown".to_string())
                ),
            },
            Err(e) => format!("browser transport error: {e}"),
        }
    }

    #[tool(
        name = "set_session_title",
        description = "Set a concise title for the current Termul chat session. Call this EXACTLY ONCE per session, during the first turn, as soon as the user's intent is clear. Do not call it again for the same session — subsequent calls are ignored."
    )]
    async fn set_session_title(
        &self,
        Parameters(input): Parameters<TermulSetTitleInput>,
    ) -> String {
        let request = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::SetTitle,
            todos: Vec::new(),
            title: Some(input.title),
            browser_action: None,
            browser_args: None,
            browser_element: None,
        };
        match forward_to_parent(&self.config, request, "title updated").await {
            Ok(msg) => msg,
            Err(e) => format!("set_session_title error: {e}"),
        }
    }
}

/// Connect to the parent TCP listener, send one frame, read one reply.
/// Fresh connection per call (localhost, sub-ms) — simplest + most robust.
/// The whole round trip is bounded so a wedged parent can't hang the agent's
/// tool call indefinitely.
async fn forward_to_parent(
    config: &ChildConfig,
    request: FrameRequest,
    success_message: &'static str,
) -> Result<String, String> {
    // 10s covers a healthy round trip many times over; a parent that can't
    // reply by then is wedged and the agent deserves a clear timeout error.
    const ROUND_TRIP: std::time::Duration = std::time::Duration::from_secs(10);
    tokio::time::timeout(
        ROUND_TRIP,
        forward_to_parent_inner(config, request, success_message),
    )
    .await
    .map_err(|_| "parent round trip timed out".to_string())?
}

/// Browser calls can legitimately block for minutes: the consent prompt
/// waits up to 120s, `wait` up to 30s, navigation settles ~15s. The raw
/// reply is returned so typed `code`s reach the agent.
async fn forward_to_parent_raw(
    config: &ChildConfig,
    request: FrameRequest,
) -> Result<FrameReply, String> {
    const BROWSER_ROUND_TRIP: std::time::Duration = std::time::Duration::from_secs(150);
    tokio::time::timeout(BROWSER_ROUND_TRIP, async move {
        let mut stream = TcpStream::connect(("127.0.0.1", config.port))
            .await
            .map_err(|e| format!("connect to parent failed: {e}"))?;
        let mut buf = serde_json::to_vec(&request).map_err(|e| format!("encode frame: {e}"))?;
        buf.push(b'\n');
        stream
            .write_all(&buf)
            .await
            .map_err(|e| format!("write frame: {e}"))?;
        // Snapshot payloads are large; keep the cap generous.
        const MAX_REPLY: u64 = 1024 * 1024;
        let mut reader = BufReader::new(stream.take(MAX_REPLY));
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read reply: {e}"))?;
        serde_json::from_str(&line).map_err(|e| format!("decode reply: {e}"))
    })
    .await
    .map_err(|_| "parent round trip timed out".to_string())?
}

async fn forward_to_parent_inner(
    config: &ChildConfig,
    request: FrameRequest,
    success_message: &'static str,
) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", config.port))
        .await
        .map_err(|e| format!("connect to parent failed: {e}"))?;
    let mut buf = serde_json::to_vec(&request).map_err(|e| format!("encode frame: {e}"))?;
    buf.push(b'\n');
    stream
        .write_all(&buf)
        .await
        .map_err(|e| format!("write frame: {e}"))?;

    const MAX_REPLY: u64 = 64 * 1024;
    let mut reader = BufReader::new(stream.take(MAX_REPLY));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read reply: {e}"))?;
    let reply: FrameReply =
        serde_json::from_str(&line).map_err(|e| format!("decode reply: {e}"))?;
    if reply.ok {
        Ok(success_message.to_string())
    } else {
        Err(reply.error.unwrap_or_else(|| "unknown error".to_string()))
    }
}

/// Drive the rmcp server over stdio. Returns when the agent closes stdin
/// (normal disconnect) or the server fails to initialize.
async fn serve_mcp_server(config: ChildConfig) -> Result<(), String> {
    let (stdin, stdout) = rmcp::transport::io::stdio();
    serve_mcp_transport(config, stdin, stdout).await
}

/// Serve one MCP session on an already-split byte pipe.
///
/// Antigravity opens with `server/discover` and an empty `params` object.
/// rmcp 3.5 accepts that method, then requires 2026-07-28 `_meta` on every
/// request in that session. Fill the two required keys when they are absent.
/// A session that starts with `initialize` is copied unchanged.
async fn serve_mcp_transport<R, W>(config: ChildConfig, stdin: R, stdout: W) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (server_side, shim_side) = tokio::io::duplex(1024 * 1024);
    let (server_read, server_write) = tokio::io::split(server_side);
    // The server writes replies on `stdout`. This half only exists because
    // `split` yields both directions of the duplex.
    drop(server_write);
    tokio::spawn(async move {
        let _ = copy_with_discover_meta(stdin, shim_side).await;
    });
    let service = TermulPlanServer { config };
    let running = serve_server(service, (server_read, stdout))
        .await
        .map_err(|e| format!("mcp server initialize failed: {e}"))?;
    // Wait until the transport closes (agent disconnect → stdin EOF).
    running
        .waiting()
        .await
        .map_err(|e| format!("mcp server ended with error: {e}"))?;
    Ok(())
}

const DISCOVER_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const DISCOVER_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";

/// Copy stdin to the rmcp server. After `server/discover`, fill missing
/// request `_meta` so later `tools/list` and `tools/call` pass the 2026
/// handshake. Does not log message bodies.
async fn copy_with_discover_meta<R, W>(reader: R, mut writer: W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut discover_session = false;
    let mut classified = false;
    let mut logged_fill = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).await?;
        if n == 0 {
            break;
        }
        let had_newline = line.last() == Some(&b'\n');
        let mut body = if had_newline {
            &line[..line.len() - 1]
        } else {
            &line[..]
        };
        if body.last() == Some(&b'\r') {
            body = &body[..body.len() - 1];
        }
        let text = String::from_utf8_lossy(body);
        if !classified {
            classified = true;
            discover_session = json_method_is_discover(&text);
        }
        let (out, filled) = if discover_session {
            fill_discover_request_meta(&text)
        } else {
            (text.into_owned(), false)
        };
        if filled && !logged_fill {
            eprintln!("[host-mcp-child] filled missing MCP request metadata");
            logged_fill = true;
        }
        writer.write_all(out.as_bytes()).await?;
        if had_newline {
            writer.write_all(b"\n").await?;
        }
    }
    Ok(())
}

fn json_method_is_discover(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("method")?.as_str().map(str::to_string))
        .is_some_and(|method| method == "server/discover")
}

/// Return the line unchanged when it is not a JSON-RPC request, or when the
/// required 2026-07-28 `_meta` keys are already present.
fn fill_discover_request_meta(line: &str) -> (String, bool) {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) else {
        return (line.to_string(), false);
    };
    let Some(obj) = value.as_object_mut() else {
        return (line.to_string(), false);
    };
    let Some(method) = obj
        .get("method")
        .and_then(|m| m.as_str())
        .map(str::to_string)
    else {
        return (line.to_string(), false);
    };
    if method == "initialize" || !obj.contains_key("id") {
        return (line.to_string(), false);
    }
    let params = obj.entry("params").or_insert_with(|| serde_json::json!({}));
    let Some(params_obj) = params.as_object_mut() else {
        return (line.to_string(), false);
    };
    let meta = params_obj
        .entry("_meta")
        .or_insert_with(|| serde_json::json!({}));
    let Some(meta_obj) = meta.as_object_mut() else {
        return (line.to_string(), false);
    };
    let mut filled = false;
    if !meta_obj.contains_key(DISCOVER_PROTOCOL_VERSION) {
        meta_obj.insert(
            DISCOVER_PROTOCOL_VERSION.to_string(),
            serde_json::json!("2026-07-28"),
        );
        filled = true;
    }
    if !meta_obj.contains_key(DISCOVER_CLIENT_CAPABILITIES) {
        meta_obj.insert(
            DISCOVER_CLIENT_CAPABILITIES.to_string(),
            serde_json::json!({}),
        );
        filled = true;
    }
    if !filled {
        return (line.to_string(), false);
    }
    (
        serde_json::to_string(&value).unwrap_or_else(|_| line.to_string()),
        true,
    )
}

#[cfg(test)]
mod tests;
