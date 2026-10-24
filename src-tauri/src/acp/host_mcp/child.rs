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

use rmcp::handler::server::router::tool::{ToolRoute, ToolRouter};
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, GetPromptRequestParams, GetPromptResponse, GetPromptResult,
    ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Tool,
};
use rmcp::service::{serve_server, RequestContext};
use rmcp::{tool, tool_handler, tool_router, ErrorData, RoleServer, ServerHandler};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use serde::Deserialize;

use crate::acp::host_mcp::canvas_tools;
use crate::acp::host_mcp::{
    session_instructions, FrameKind, FrameReply, FrameRequest, TermulAskUserInput,
    TermulPlanInput, TermulSetTitleInput, ENV_AGENT_ID, ENV_PORT, ENV_SESSION_ID, ENV_TOKEN,
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

/// The rmcp MCP server service backing the host tools. Holds the
/// per-session connection info (port + token + session_id) so each
/// `tools/call` can open a fresh TCP connection to the parent.
struct TermulPlanServer {
    config: ChildConfig,
    /// The host tools plus figcraft's canvas tools, present from session start
    /// whether or not a canvas is open, plus the described `browser` tool.
    tool_router: ToolRouter<Self>,
}

/// The `browser` tool as the parent describes it. The child embeds no
/// browser tool text of its own.
#[derive(Debug, Deserialize)]
struct DescribedTool {
    description: String,
    input_schema: rmcp::model::JsonObject,
    /// How long to wait for a browser call's reply.
    round_trip_ms: u64,
}

impl TermulPlanServer {
    fn new(config: ChildConfig, browser: Option<DescribedTool>) -> Self {
        let mut tool_router = Self::tool_router();
        for tool in canvas_tools::tools() {
            tool_router.add_route(canvas_route(tool));
        }
        if let Some(tool) = browser {
            tool_router.add_route(browser_route(tool));
        }
        Self {
            config,
            tool_router,
        }
    }

    fn frame(&self, kind: FrameKind) -> FrameRequest {
        frame(&self.config, kind)
    }

    /// Forward the raw arguments; the parent folds, checks and dispatches
    /// them and answers with the reply JSON, which goes back verbatim.
    async fn browser(
        &self,
        arguments: Option<rmcp::model::JsonObject>,
        round_trip: std::time::Duration,
    ) -> CallToolResult {
        let request = FrameRequest {
            browser_input: Some(serde_json::Value::Object(arguments.unwrap_or_default())),
            ..self.frame(FrameKind::Browser)
        };
        let exchange = tokio::time::timeout(round_trip, exchange_frame(&self.config, request)).await;
        let reply = match exchange {
            Err(_) => serde_json::json!({
                "ok": false,
                "code": "timeout",
                "reason": "host_round_trip",
                "message": "the Termul host did not answer in time",
            }),
            Ok(reply) => browser_reply(reply),
        };
        if reply["ok"] == serde_json::Value::Bool(true) {
            CallToolResult::structured(reply)
        } else {
            CallToolResult::structured_error(reply)
        }
    }
}

/// The reply JSON for a browser frame exchange: the parent's reply
/// verbatim, or a failure shaped like one when the parent never produced
/// it.
fn browser_reply(reply: Result<FrameReply, String>) -> serde_json::Value {
    match reply {
        Ok(FrameReply {
            result: Some(result),
            ..
        }) => result,
        Ok(FrameReply {
            ok: true,
            result: None,
            ..
        }) => serde_json::json!({ "ok": true }),
        Ok(FrameReply { code, error, .. }) => serde_json::json!({
            "ok": false,
            "code": code.unwrap_or_else(|| "internal".to_string()),
            "message": error.unwrap_or_else(|| "the Termul host rejected the call".to_string()),
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "code": "internal",
            "reason": "host_unreachable",
            "message": e,
        }),
    }
}

fn frame(config: &ChildConfig, kind: FrameKind) -> FrameRequest {
    FrameRequest {
        token: config.token.clone(),
        session_id: config.session_id.clone(),
        kind,
        ..FrameRequest::default()
    }
}

fn canvas_route(tool: Tool) -> ToolRoute<TermulPlanServer> {
    ToolRoute::new_dyn(tool, |context: ToolCallContext<'_, TermulPlanServer>| {
        let config = context.service.config.clone();
        let name = context.name.to_string();
        let arguments = context.arguments.map_or(Value::Null, Value::Object);
        Box::pin(async move {
            Ok(canvas_tools::call_tool(config, name, arguments)
                .await
                .into())
        })
    })
}

fn browser_route(tool: DescribedTool) -> ToolRoute<TermulPlanServer> {
    let round_trip = std::time::Duration::from_millis(tool.round_trip_ms);
    let attr = rmcp::model::Tool::new("browser", tool.description, tool.input_schema);
    ToolRoute::new_dyn(attr, move |ctx: ToolCallContext<'_, TermulPlanServer>| {
        let service = ctx.service;
        let arguments = ctx.arguments;
        Box::pin(async move { Ok(service.browser(arguments, round_trip).await.into()) })
    })
}

/// Fetch the `browser` tool from the parent. `None` (logged) leaves the
/// tool unserved: no browser tool rather than a guessed one.
async fn describe_browser_tool(config: &ChildConfig) -> Option<DescribedTool> {
    let request = frame(config, FrameKind::Describe);
    let budget = crate::browser_automation::budgets::DESCRIBE;
    let described = match tokio::time::timeout(budget, exchange_frame(config, request)).await {
        Ok(Ok(FrameReply {
            ok: true,
            result: Some(result),
            ..
        })) => serde_json::from_value(result).ok(),
        _ => None,
    };
    if described.is_none() {
        eprintln!("[host-mcp-child] browser tool not served: describe failed");
    }
    described
}

/// The static host tools. `get_info` lives in its own `ServerHandler`
/// block below so it can attach `session_instructions()` to the
/// `initialize` result — the channel that advertises the chat renderer's
/// markdown affordances and the design canvas to the agent.
#[tool_router]
impl TermulPlanServer {
    #[tool(
        name = "plan",
        description = "Update the execution plan / todo list shown in the Termul plan panel. You MUST call this instead of any built-in todo/task tool — do not maintain your own todo list. Every time you would create or update a task, call this tool so the user sees a unified plan UI across all agents."
    )]
    async fn plan(&self, Parameters(input): Parameters<TermulPlanInput>) -> String {
        let request = FrameRequest {
            todos: input.todos,
            ..self.frame(FrameKind::Plan)
        };
        match forward_to_parent(&self.config, request, "plan updated").await {
            Ok(msg) => msg,
            Err(e) => format!("plan error: {e}"),
        }
    }

    #[tool(
        name = "set_session_title",
        description = "Set a concise title for the current Termul chat session. Call this EXACTLY ONCE per session, during the first turn, as soon as the user's intent is clear. Do not call it again for the same session — subsequent calls are ignored. Also pass `branch`: a short kebab-case slug for this chat's git branch (lowercase letters, digits and single hyphens, at most 48 characters, for example `fix-login-redirect`); Termul uses it to name the chat's worktree branch."
    )]
    async fn set_session_title(
        &self,
        Parameters(input): Parameters<TermulSetTitleInput>,
    ) -> String {
        let request = FrameRequest {
            title: Some(input.title),
            branch: input.branch,
            ..self.frame(FrameKind::SetTitle)
        };
        match forward_to_parent(&self.config, request, "title updated").await {
            Ok(msg) => msg,
            Err(e) => format!("set_session_title error: {e}"),
        }
    }

    #[tool(
        name = "ask_user",
        description = "Ask the user a question and wait for the answer. Use this INSTEAD of asking in plain text whenever you need a decision, a preference or missing details: the question appears as a panel in Termul and this call returns the answer. Pass `options` (label and optional description) for choices, `multi_select` to allow several picks, and `allow_free_text` (default true) to let the user type their own answer. The result is JSON: {\"answers\": [...], \"free_text\": string or null, \"cancelled\": boolean}. When cancelled is true the user dismissed the question; do not ask again unless you need the answer to continue."
    )]
    async fn ask_user(
        &self,
        Parameters(input): Parameters<TermulAskUserInput>,
        cancelled: tokio_util::sync::CancellationToken,
    ) -> String {
        let request = FrameRequest {
            ask: Some(input),
            ..self.frame(FrameKind::AskUser)
        };
        // No client-side timeout: the user decides when to answer, and the
        // parent always resolves the call (answer, cancel, or session end).
        // rmcp only signals a client cancel (a tool timeout, an abort) and
        // keeps polling this future, so hang up on the parent ourselves: that
        // is how it learns to take the question down.
        let reply = tokio::select! {
            reply = exchange_frame(&self.config, request) => reply,
            () = cancelled.cancelled() => return "ask_user cancelled by the client".to_string(),
        };
        match reply {
            Ok(reply) if reply.ok => reply
                .result
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
            Ok(reply) => format!(
                "ask_user error: {}",
                reply.error.unwrap_or_else(|| "unknown".to_string())
            ),
            Err(e) => format!("ask_user transport error: {e}"),
        }
    }
}

/// `#[tool_handler]` fills `call_tool`/`list_tools`/`get_tool` from the
/// per-instance router (static tools, canvas tools and the described
/// `browser` tool) and skips `get_info` because it is provided here: the
/// returned `instructions` land in the MCP `initialize` result so agents
/// learn they can embed images, link files for open-in-editor, and design
/// on the canvas. Resources and prompts are figcraft's, answered by
/// `canvas_tools`.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for TermulPlanServer {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::ServerConfig::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_instructions(session_instructions())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        canvas_tools::request(self.config.clone(), "resources/list", json!({})).await
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        canvas_tools::request(self.config.clone(), "resources/templates/list", json!({})).await
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let params = json!({ "uri": request.uri });
        canvas_tools::request::<ReadResourceResult>(self.config.clone(), "resources/read", params)
            .await
            .map(Into::into)
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        canvas_tools::request(self.config.clone(), "prompts/list", json!({})).await
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        let params = json!({ "name": request.name, "arguments": request.arguments });
        canvas_tools::request::<GetPromptResult>(self.config.clone(), "prompts/get", params)
            .await
            .map(Into::into)
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

/// Send one frame to the parent and read its reply, with no timeout of its
/// own. Callers bound it when the parent is expected to answer promptly.
async fn exchange_frame(config: &ChildConfig, request: FrameRequest) -> Result<FrameReply, String> {
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
    let browser = describe_browser_tool(&config).await;
    let service = TermulPlanServer::new(config, browser);
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
