use super::*;

pub(super) fn stable_agent_namespace(config: &AgentConfig) -> Option<String> {
    if let Some(config_id) = config
        .config_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("config:{config_id}"));
    }
    // Safe fallback identity: normalized display name + executable basename +
    // stable boolean flags. Never hash full paths, args, or env because those
    // frequently contain usernames, workspaces, credentials, and tokens.
    let name = config.name.split_whitespace().collect::<Vec<_>>().join(" ");
    let command = config.command.replace('\\', "/");
    let basename = command.rsplit('/').next().unwrap_or_default().trim();
    if name.is_empty() || basename.is_empty() || matches!(basename, "." | "..") {
        return None;
    }
    let identity = format!(
        "{}\0{}\0terminal={}",
        name.to_ascii_lowercase(),
        basename.to_ascii_lowercase(),
        config.allow_terminal
    );
    let mut hash = 0xcbf29ce484222325u64;
    for byte in identity.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("agent-safe:{hash:016x}"))
}

/// Validate project/session MCP transports against negotiated capabilities.
/// Stdio is mandatory in ACP; HTTP/SSE require their advertised flags.
pub(super) fn gate_mcp_servers(
    caps: &AgentCapabilities,
    servers: &[McpServer],
) -> Result<(), String> {
    for server in servers {
        match server {
            McpServer::Stdio(_) => {}
            McpServer::Http(_) if caps.mcp_capabilities.http => {}
            McpServer::Sse(_) if caps.mcp_capabilities.sse => {}
            McpServer::Http(_) => {
                return Err("agent does not support HTTP MCP servers".to_string());
            }
            McpServer::Sse(_) => {
                return Err("agent does not support SSE MCP servers".to_string());
            }
            _ => return Err("agent does not support this MCP transport".to_string()),
        }
    }
    Ok(())
}

/// Inject OAuth Bearer tokens into HTTP/SSE MCP server configs before `session/new`. The token is loaded from the file store (written by `acp_mcp_oauth_start`). Only injects if the server has no existing Authorization header — never overrides a user-configured token.
pub(super) fn inject_oauth_tokens(mcp_servers: Vec<McpServer>) -> Vec<McpServer> {
    mcp_servers
        .into_iter()
        .map(|server| match server {
            McpServer::Http(mut http) => {
                if !http
                    .headers
                    .iter()
                    .any(|h| h.name.eq_ignore_ascii_case("Authorization"))
                {
                    match crate::acp::mcp_oauth::get_valid_token_blocking(&http.url) {
                        Ok(Some(token)) => {
                            http.headers
                                .push(agent_client_protocol::schema::v1::HttpHeader::new(
                                    "Authorization",
                                    format!("Bearer {token}"),
                                ));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::warn!(
                                "[mcp-oauth] token lookup failed for MCP server (url redacted): {e}"
                            );
                        }
                    }
                }
                McpServer::Http(http)
            }
            McpServer::Sse(mut sse) => {
                if !sse
                    .headers
                    .iter()
                    .any(|h| h.name.eq_ignore_ascii_case("Authorization"))
                {
                    match crate::acp::mcp_oauth::get_valid_token_blocking(&sse.url) {
                        Ok(Some(token)) => {
                            sse.headers
                                .push(agent_client_protocol::schema::v1::HttpHeader::new(
                                    "Authorization",
                                    format!("Bearer {token}"),
                                ));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::warn!(
                                "[mcp-oauth] token lookup failed for MCP server (url redacted): {e}"
                            );
                        }
                    }
                }
                McpServer::Sse(sse)
            }
            other => other,
        })
        .collect()
}

/// Build the internal `termul` MCP server config (for the `plan` tool; stdio self-spawn) to
/// prepend into a session's `mcp_servers`. The agent spawns
/// `current_exe() --internal-mcp-plan-server` as a child; the child reads
/// `TERMUL_PLAN_PORT` / `_TOKEN` / `_SESSION_ID` / `_AGENT_ID` from env,
/// runs an rmcp MCP server over stdio, and forwards `plan` calls to
/// the parent TCP listener. The internal server is `McpServer::Stdio`, which
/// `gate_mcp_servers` accepts unconditionally (stdio is mandatory in ACP), so
/// no gate relaxation is needed.
pub(super) fn build_internal_plan_stdio(
    agent_id: &str,
    port: u16,
    token: &str,
    provisional_sid: &str,
) -> Vec<McpServer> {
    let exe = std::env::current_exe().unwrap_or_else(|e| {
        log::warn!("[host-mcp] current_exe() failed ({e}); falling back to PATH lookup");
        std::path::PathBuf::from("termul-manager")
    });
    let env = vec![
        EnvVariable::new(crate::acp::host_mcp::ENV_PORT, port.to_string()),
        EnvVariable::new(crate::acp::host_mcp::ENV_TOKEN, token.to_string()),
        EnvVariable::new(
            crate::acp::host_mcp::ENV_SESSION_ID,
            provisional_sid.to_string(),
        ),
        EnvVariable::new(crate::acp::host_mcp::ENV_AGENT_ID, agent_id.to_string()),
    ];
    let stdio = McpServerStdio::new("termul".to_string(), exe)
        .args(vec![crate::acp::host_mcp::CHILD_ARG.to_string()])
        .env(env);
    vec![McpServer::Stdio(stdio)]
}

/// Map the agent's advertised `initialize` auth methods to the renderer-facing
/// [`AuthMethodInfo`] contract. Every method is forwarded — no agent-type
/// filtering — with the `type` discriminator (`'agent' | 'terminal' |
/// 'env_var'`) so the renderer decides how to present them (Sign-in button vs.
/// terminal tab vs. env-var prompt). `args`/`env` are populated only for
/// `terminal` methods (the command the renderer runs in a real terminal tab).
/// Extracted so the mapping can be unit-tested without a live connection.
pub(super) fn to_auth_method_infos(
    methods: &[AuthMethod],
    login_env: &std::collections::HashMap<String, String>,
) -> Vec<AuthMethodInfo> {
    methods
        .iter()
        .map(|m| {
            let terminal_auth = terminal_auth_args(m.meta());
            let (r#type, args, env, args_mode) = match m {
                AuthMethod::Terminal(t) => (
                    "terminal",
                    Some(t.args.clone()),
                    Some(t.env.clone()),
                    Some("append".to_string()),
                ),
                // `env_var` forwards `type` only — the renderer shows a
                // disabled "not supported" entry (respawn-with-env is out of
                // scope), so `vars`/`link` are not carried on the wire.
                AuthMethod::EnvVar(_) => ("env_var", None, None, None),
                // OpenCode keeps the method type `agent` and puts
                // `opencode auth login` under `_meta["terminal-auth"]`.
                _ if terminal_auth.is_some() => (
                    "terminal",
                    terminal_auth,
                    Some(login_env.clone()),
                    Some("replace".to_string()),
                ),
                // `AuthMethod` is `#[non_exhaustive]`; a future variant maps to
                // `agent` (the generic sign-in action) rather than being
                // dropped, keeping the `type` union closed.
                _ => ("agent", None, None, None),
            };
            AuthMethodInfo {
                id: m.id().to_string(),
                name: m.name().to_string(),
                description: m.description().map(str::to_string),
                r#type: r#type.to_string(),
                args,
                env,
                args_mode,
            }
        })
        .collect()
}

/// Args from `_meta["terminal-auth"]`. The command name is ignored: the
/// renderer runs the installed agent binary.
fn terminal_auth_args(
    meta: Option<&agent_client_protocol::schema::v1::Meta>,
) -> Option<Vec<String>> {
    let args = meta?
        .get(crate::acp::client::TERMINAL_AUTH_META_KEY)?
        .get("args")?
        .as_array()?;
    let argv: Vec<String> = args
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    if argv.is_empty() {
        None
    } else {
        Some(argv)
    }
}

/// Capability gate for `session/load`: requires the agent's `loadSession`
/// capability. Returns a typed error (without contacting the agent) when it is
/// absent. Extracted so the real gate can be unit-tested without an AppHandle.
pub(super) fn gate_load_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.load_session {
        Ok(())
    } else {
        Err("agent does not support session/load (loadSession capability)".to_string())
    }
}

/// Capability gate for `session/resume`: requires `sessionCapabilities.resume`.
pub(super) fn gate_resume_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.resume.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/resume".to_string())
    }
}

/// Capability gate for `session/close`: requires `sessionCapabilities.close`.
pub(super) fn gate_close_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.close.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/close".to_string())
    }
}

/// Capability gate for `session/list`: requires `sessionCapabilities.list`.
/// Per the ACP spec: "If `sessionCapabilities.list` is not present … Clients
/// MUST NOT attempt to call `session/list`."
pub(super) fn gate_list_sessions(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.list.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/list (sessionCapabilities.list)".to_string())
    }
}

/// Send a command to a driver thread and await its `Send` oneshot reply.
pub(super) async fn send_command<T>(
    command_tx: &mpsc::UnboundedSender<AcpCommand>,
    make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> AcpCommand,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    command_tx
        .send(make(reply_tx))
        .map_err(|_| "agent thread is no longer running".to_string())?;
    reply_rx
        .await
        .map_err(|_| "agent thread dropped the reply".to_string())?
}

/// Join a driver thread without ever blocking the async runtime indefinitely.
///
/// The join runs on the blocking pool and is capped at [`JOIN_TIMEOUT`]; if a
/// wedged agent thread refuses to exit, we abandon the join (the OS reclaims
/// the thread at process exit) rather than hang the caller / app-exit path.
pub(super) async fn join_thread_bounded(handle: JoinHandle<()>) {
    let join = tokio::task::spawn_blocking(move || {
        let _ = handle.join();
    });
    if tokio::time::timeout(JOIN_TIMEOUT, join).await.is_err() {
        log::warn!("[acp] agent thread did not exit within {JOIN_TIMEOUT:?}; abandoning join");
    }
}

/// Story 8: finalize the durable record of a successfully closed session.
/// Backend-ephemeral sessions (un-promoted warm-pool seeds, one-shot
/// generations) were never registered, so finalizing them would surface a
/// spurious "history finalization failed" — they skip the call entirely.
pub(super) async fn finalize_closed_session_if_durable(
    persistence: Option<&Arc<SessionPersistence>>,
    session_id: &str,
    was_ephemeral: bool,
) -> Result<(), String> {
    if was_ephemeral {
        return Ok(());
    }
    let Some(persistence) = persistence else {
        return Ok(());
    };
    persistence
        .finalize_session(session_id, PersistedSessionStatus::Closed)
        .await
        .map_err(|error| format!("session closed but history finalization failed: {error}"))
}

/// Outcome of a successful promote: whether the session actually transitioned
/// (vs an idempotent no-op on an already-durable session) and, on a real
/// transition, the current title to echo in the `session_info_update` notify.
#[derive(Debug)]
pub(super) struct PromoteOutcome {
    pub(super) promoted: bool,
    pub(super) title: Option<String>,
}

/// Story 8 (ephemeral warm pool): promote a backend-ephemeral session to
/// durable — register the persistence metadata captured at `session/new`,
/// then clear the ephemeral mark. Register-then-unmark ordering means a
/// persistence failure leaves the session ephemeral (no half-promoted state).
/// Idempotent no-op for an already-durable session; `Err(unknown session)`
/// when the driver never created it.
pub(super) async fn promote_session_in_driver(
    driver_state: &Arc<Mutex<DriverState>>,
    persistence: Option<&Arc<SessionPersistence>>,
    agent_id: &AgentId,
    session_id: &SessionId,
) -> Result<PromoteOutcome, String> {
    let registration = {
        let state = driver_state.lock();
        if state.session_root(&session_id.0).is_none() {
            log::warn!(
                "[acp] {agent_id} session promotion failed: unknown session {}",
                crate::logging::redact_session_id(&session_id.0)
            );
            return Err(format!(
                "unknown session: {}",
                crate::logging::redact_session_id(&session_id.0)
            ));
        }
        if !state.is_ephemeral(&session_id.0) {
            // Already durable — promotion is an idempotent no-op.
            return Ok(PromoteOutcome {
                promoted: false,
                title: None,
            });
        }
        state.promotable_registration(&session_id.0)
    };
    let Some(persistence) = persistence else {
        // No durable store attached (e.g. desktop without persistence): the
        // session stays ephemeral and chat remains non-durable.
        log::warn!(
            "[acp] {agent_id} session {} promotion failed: persistence unavailable",
            crate::logging::redact_session_id(&session_id.0)
        );
        return Err("session persistence unavailable".to_string());
    };
    // The NewSession arm marks + stashes together (single producer), so a
    // missing stash is a driver bug, not a recoverable case — fail loudly
    // rather than registering a cwd-only record that silently loses the
    // project/namespace/worktree metadata.
    let Some(registration) = registration else {
        log::warn!(
            "[acp] {agent_id} session {} promotion failed: ephemeral without a promotable registration (driver bug)",
            crate::logging::redact_session_id(&session_id.0)
        );
        return Err(format!(
            "session {} is ephemeral but has no promotable registration (driver bug)",
            crate::logging::redact_session_id(&session_id.0)
        ));
    };
    let metadata = persistence
        .register_session(registration)
        .await
        .map_err(|error| {
            log::warn!(
                "[acp] {agent_id} session {} promotion failed: durable registration write failed: {error}",
                crate::logging::redact_session_id(&session_id.0)
            );
            format!("failed to persist promoted session: {error}")
        })?;
    converge_promoted_session(driver_state, persistence, agent_id, session_id).await?;
    Ok(PromoteOutcome {
        promoted: true,
        title: metadata.title,
    })
}

/// Story 8: post-register convergence for a promoted session. The register
/// await dropped the driver-state lock, so a concurrent CloseSession /
/// DisposeEphemeralSession in the same driver may have removed the session
/// mid-promote (its close skipped finalization because the mark was still
/// ephemeral at that check). If the session is gone, finalize the just-written
/// record Closed so it cannot linger as a phantom Active entry, and report the
/// race. Otherwise clear the ephemeral mark — the session is now durable.
pub(super) async fn converge_promoted_session(
    driver_state: &Arc<Mutex<DriverState>>,
    persistence: &Arc<SessionPersistence>,
    agent_id: &AgentId,
    session_id: &SessionId,
) -> Result<(), String> {
    {
        let mut state = driver_state.lock();
        if state.session_root(&session_id.0).is_some() {
            state.unmark_ephemeral(&session_id.0);
            log::info!(
                "[acp] {agent_id} session {} promoted to durable",
                crate::logging::redact_session_id(&session_id.0)
            );
            return Ok(());
        }
    }
    if let Err(error) = persistence
        .finalize_session(&session_id.0, PersistedSessionStatus::Closed)
        .await
    {
        log::warn!("[acp] {agent_id} finalizing a promote-raced session failed: {error}");
    }
    Err(format!(
        "session {} closed during promotion",
        crate::logging::redact_session_id(&session_id.0)
    ))
}

/// Per-agent runtime behavior quirks, resolved ONCE at spawn from the
/// agent-identity predicate ([`crate::acp::factory_key::is_factory_droid`] —
/// the single source). Threading a bare bool through the driver made each
/// gated behavior easy to forget; the profile names them.
#[derive(Debug, Clone, Copy)]
pub(super) struct AgentRuntimeProfile {
    /// Factory Droid echoes environment values in its stdio trace: suppress
    /// the raw stdin/stdout JSON-RPC trace and log agent stderr length-only.
    pub(super) redact_output: bool,
    /// Droid acknowledges `session/set_config_option` with `{}` instead of the
    /// ACP-required full snapshot: parse its reply leniently
    /// (`factory_config_option_result`).
    pub(super) lenient_config_option_ack: bool,
    /// Replace crash/initialize failure messages with a generic Factory Droid
    /// string toward the renderer (agents may echo env values in errors).
    pub(super) mask_failure_details: bool,
    /// Claude Agent ACP omits reasoning text unless the session asks for a
    /// summarized thinking display. The chat already renders `agent_thought_chunk`
    /// as a Thought row.
    pub(super) summarize_thinking: bool,
}

/// True for the managed Claude ACP agent and for a process launched from the
/// `claude-agent-acp` package.
pub(super) fn requests_summarized_thinking(config: &AgentConfig) -> bool {
    config.config_id.as_deref() == Some("acp-registry:claude-acp")
        || config.command.contains("claude-agent-acp")
        || config
            .args
            .iter()
            .any(|arg| arg.contains("claude-agent-acp"))
}

/// `_meta.claudeCode.options.thinking` for Claude Agent ACP.
///
/// The adapter copies this object onto the Agent SDK query. `display:
/// "summarized"` is what makes current Claude models return reasoning text.
/// Without it, thinking blocks arrive empty and Termul draws no Thought row.
pub(super) fn summarized_thinking_meta() -> Meta {
    Meta::from_iter([(
        "claudeCode".to_string(),
        serde_json::json!({
            "options": {
                "thinking": { "type": "adaptive", "display": "summarized" }
            }
        }),
    )])
}

impl AgentRuntimeProfile {
    pub(super) fn resolve(config: &AgentConfig) -> Self {
        let factory_droid = crate::acp::factory_key::is_factory_droid(config);
        Self {
            redact_output: factory_droid,
            lenient_config_option_ack: factory_droid,
            mask_failure_details: factory_droid,
            summarize_thinking: requests_summarized_thinking(config),
        }
    }
}

/// The Linux pidfd reaper busy-loops on the agent thread when its fd stays
/// readable. That cfg is a rustc flag from `.cargo/config.toml`; a binary
/// built without it (repo-root `cargo build --manifest-path` before the root
/// config existed) still runs the spinning backend. Say so once, at the first
/// spawn.
pub(super) fn warn_if_pidfd_reaper() {
    #[cfg(all(unix, not(async_process_force_signal_backend)))]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            log::warn!(
                "[acp] async-process is using the Linux pidfd reaper; an idle acp-agent thread can pin a CPU core. Rebuild with async_process_force_signal_backend set (.cargo/config.toml at the repo root and in src-tauri)"
            );
        });
    }
}

/// Image, audio, and embedded-context support from `initialize`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PromptBlockSupport {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

/// Reject prompt blocks the agent did not advertise. `text` and
/// `resource_link` are baseline. Image, audio, and embedded resources
/// require the matching prompt capability.
pub(crate) fn reject_unsupported_prompt_blocks(
    content: &[agent_client_protocol::schema::v1::ContentBlock],
    image: bool,
    audio: bool,
    embedded_context: bool,
) -> Result<(), String> {
    use agent_client_protocol::schema::v1::ContentBlock;
    for block in content {
        match block {
            ContentBlock::Text(_) | ContentBlock::ResourceLink(_) => {}
            ContentBlock::Image(_) if image => {}
            ContentBlock::Audio(_) if audio => {}
            ContentBlock::Resource(_) if embedded_context => {}
            ContentBlock::Image(_) => {
                return Err("ACP_PROMPT_CAPABILITY: image is not supported".to_string());
            }
            ContentBlock::Audio(_) => {
                return Err("ACP_PROMPT_CAPABILITY: audio is not supported".to_string());
            }
            ContentBlock::Resource(_) => {
                return Err("ACP_PROMPT_CAPABILITY: embedded context is not supported".to_string());
            }
            _ => {
                return Err("ACP_PROMPT_CAPABILITY: unsupported content block".to_string());
            }
        }
    }
    Ok(())
}

/// ACP requires an absolute `cwd` on session lifecycle requests.
pub(super) fn require_absolute_cwd(cwd: &str) -> Result<(), String> {
    if std::path::Path::new(cwd).is_absolute() {
        Ok(())
    } else {
        Err(format!("cwd must be absolute: {cwd}"))
    }
}

/// Droid acknowledges `session/set_config_option` with `{}` instead of the
/// ACP-required full snapshot. Treat that empty object as acceptance without
/// a snapshot (`Ok(None)`). The renderer keeps the last snapshot and applies
/// the selected value. A malformed body is still an error, so it cannot
/// replace the known options with an empty list.
pub(super) fn factory_config_option_result(
    value: Value,
) -> Result<Option<Vec<SessionConfigOption>>, String> {
    if value.as_object().is_some_and(|object| object.is_empty()) {
        return Ok(None);
    }
    // The schema's DefaultOnError would otherwise turn a malformed field into
    // an empty list, silently clearing all visible options.
    if !value.get("configOptions").is_some_and(Value::is_array) {
        return Err("Factory Droid returned invalid config options".to_string());
    }
    serde_json::from_value::<SetSessionConfigOptionResponse>(value)
        .map(|response| Some(response.config_options))
        .map_err(|_| "Factory Droid returned invalid config options".to_string())
}
