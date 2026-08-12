//! Child side of the host-injected plan tool.
//!
//! Entered via the hidden `--internal-mcp-plan-server` subcommand (both the
//! desktop `termul-manager` and standalone `termul-server` binaries branch on
//! this flag in `main` / `server_main` BEFORE any Tauri/AppHandle setup). The
//! agent spawns `current_exe() --internal-mcp-plan-server` as the injected
//! `McpServer::Stdio`; the child inherits the agent-provided stdin/stdout (the
//! MCP stdio transport).
//!
//! The child runs an rmcp MCP SERVER over stdio exposing the `termul_plan`
//! tool. On each `tools/call`, it opens a fresh TCP connection to the parent
//! (port + token from env), forwards the input, and returns the parent's reply
//! to the agent. Minimal runtime: no Tauri plugins, no `AppHandle`, no sinks —
//! works identically on desktop + standalone.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::service::serve_server;
use rmcp::{tool, tool_router};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::acp::host_mcp::{
    FrameKind, FrameReply, FrameRequest, TermulPlanInput, TermulSetTitleInput, ENV_AGENT_ID,
    ENV_PORT, ENV_SESSION_ID, ENV_TOKEN,
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

/// The rmcp MCP server service backing `termul_plan`. Holds the per-session
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
        name = "termul_plan",
        description = "Update the execution plan / todo list shown in the Termul plan panel. Call this instead of a built-in todo tool so the user sees a unified plan UI across all agents."
    )]
    async fn termul_plan(&self, Parameters(input): Parameters<TermulPlanInput>) -> String {
        let request = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::Plan,
            todos: input.todos,
            title: None,
        };
        match forward_to_parent(&self.config, request, "plan updated").await {
            Ok(msg) => msg,
            Err(e) => format!("termul_plan error: {e}"),
        }
    }

    #[tool(
        name = "termul_set_session_title",
        description = "Set a concise title for the current Termul chat session. Call this during the first turn as soon as the user's intent is clear."
    )]
    async fn termul_set_session_title(
        &self,
        Parameters(input): Parameters<TermulSetTitleInput>,
    ) -> String {
        let request = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::SetTitle,
            todos: Vec::new(),
            title: Some(input.title),
        };
        match forward_to_parent(&self.config, request, "title updated").await {
            Ok(msg) => msg,
            Err(e) => format!("termul_set_session_title error: {e}"),
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

    let mut reader = BufReader::new(stream);
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
    let service = TermulPlanServer { config };
    let running = serve_server(service, (stdin, stdout))
        .await
        .map_err(|e| format!("mcp server initialize failed: {e}"))?;
    // Wait until the transport closes (agent disconnect → stdin EOF).
    running
        .waiting()
        .await
        .map_err(|e| format!("mcp server ended with error: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_env(port: &str, token: &str, session: &str, agent: &str) {
        std::env::set_var(ENV_PORT, port);
        std::env::set_var(ENV_TOKEN, token);
        std::env::set_var(ENV_SESSION_ID, session);
        std::env::set_var(ENV_AGENT_ID, agent);
    }

    fn clear_env() {
        std::env::remove_var(ENV_PORT);
        std::env::remove_var(ENV_TOKEN);
        std::env::remove_var(ENV_SESSION_ID);
        std::env::remove_var(ENV_AGENT_ID);
    }

    // `parse_env` reads `std::env` — these tests are not parallel-safe, so
    // serialize them with a shared lock.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn parse_env_rejects_missing_port() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        std::env::set_var(ENV_TOKEN, "tok");
        std::env::set_var(ENV_SESSION_ID, "sess");
        let err = parse_env().expect_err("missing PORT must error");
        assert!(err.contains(ENV_PORT));
        clear_env();
    }

    #[test]
    fn parse_env_rejects_missing_token() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        std::env::set_var(ENV_PORT, "1234");
        std::env::set_var(ENV_SESSION_ID, "sess");
        let err = parse_env().expect_err("missing TOKEN must error");
        assert!(err.contains(ENV_TOKEN));
        clear_env();
    }

    #[test]
    fn parse_env_rejects_missing_session_id() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        std::env::set_var(ENV_PORT, "1234");
        std::env::set_var(ENV_TOKEN, "tok");
        let err = parse_env().expect_err("missing SESSION_ID must error");
        assert!(err.contains(ENV_SESSION_ID));
        clear_env();
    }

    #[test]
    fn parse_env_rejects_blank_token() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        set_env("1234", "   ", "sess", "agent");
        let err = parse_env().expect_err("blank TOKEN must error");
        assert!(err.contains(ENV_TOKEN));
        clear_env();
    }

    #[test]
    fn parse_env_rejects_non_numeric_port() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        set_env("not-a-port", "tok", "sess", "agent");
        let err = parse_env().expect_err("non-numeric PORT must error");
        assert!(err.contains(ENV_PORT));
        clear_env();
    }

    #[test]
    fn parse_env_accepts_valid_config() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        set_env("4242", "tok-abc", "sess-xyz", "agent-1");
        let cfg = parse_env().expect("valid env must parse");
        assert_eq!(cfg.port, 4242);
        assert_eq!(cfg.token, "tok-abc");
        assert_eq!(cfg.session_id, "sess-xyz");
        assert_eq!(cfg.agent_id, "agent-1");
        clear_env();
    }

    #[test]
    fn parse_env_agent_id_is_optional() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        set_env("4242", "tok", "sess", "");
        std::env::remove_var(ENV_AGENT_ID);
        let cfg = parse_env().expect("AGENT_ID is optional");
        assert_eq!(cfg.agent_id, "");
        clear_env();
    }
}
