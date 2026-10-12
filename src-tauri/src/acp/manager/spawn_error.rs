//! Typed prefixes for deterministic agent-spawn failures (AD-5).
//!
//! A missing agent binary or an invalid agent config is a definite rejection:
//! retrying the same request cannot succeed, so clients must never retry it
//! automatically. The manager's `Err(String)` boundary carries the verdict as
//! a stable prefix (the [`ACP_AUTH_REQUIRED_PREFIX`](super::ACP_AUTH_REQUIRED_PREFIX)
//! convention) so the WS layer maps it to a `WsErrorCode` and the desktop
//! renderer prefix-matches the same string.

/// The agent binary is missing, not installed, or the process cannot start.
pub const ACP_AGENT_UNAVAILABLE: &str = "ACP_AGENT_UNAVAILABLE";

/// The agent config is unusable (empty name, command or `configId`).
pub const ACP_INVALID_AGENT_CONFIG: &str = "ACP_INVALID_AGENT_CONFIG";

/// Which deterministic spawn failure a tagged error string carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnFailure {
    AgentUnavailable,
    InvalidAgentConfig,
}

/// Tag `detail` as [`SpawnFailure::AgentUnavailable`].
pub(crate) fn agent_unavailable(detail: impl std::fmt::Display) -> String {
    format!("{ACP_AGENT_UNAVAILABLE}: {detail}")
}

/// Tag `detail` as [`SpawnFailure::InvalidAgentConfig`].
pub(crate) fn invalid_agent_config(detail: impl std::fmt::Display) -> String {
    format!("{ACP_INVALID_AGENT_CONFIG}: {detail}")
}

/// Split a tagged spawn error into its verdict and the human message.
/// `None` for any untagged error.
pub(crate) fn classify_spawn_error(error: &str) -> Option<(SpawnFailure, &str)> {
    [
        (ACP_AGENT_UNAVAILABLE, SpawnFailure::AgentUnavailable),
        (ACP_INVALID_AGENT_CONFIG, SpawnFailure::InvalidAgentConfig),
    ]
    .into_iter()
    .find_map(|(prefix, failure)| {
        error
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix(": "))
            .map(|message| (failure, message))
    })
}

/// Whether a recorded driver start failure is the OS refusing to launch the
/// agent program for a deterministic reason: the program or its path is
/// missing, it is not executable, or it is not a runnable binary.
///
/// The SDK hands the driver only the stringified spawn `io::Error`
/// (`Error::into_internal_error`), so its kind is gone and matching is
/// wording-based. The needles are the OS error texts Rust prints for the
/// launch errnos, per platform: Unix `ENOENT` / `EACCES` / `ENOEXEC`
/// ("No such file or directory", "Permission denied", "Exec format error") and
/// Windows os errors 2 / 3 / 5 / 193 ("cannot find the file / path specified",
/// "Access is denied", "is not a valid Win32 application"), plus the `which`-style
/// "program not found" and the shell's "is not recognized as an internal or
/// external command". A failure with none of these (a driver panic, a runtime
/// build failure, a process that died before `initialize`) may be transient and
/// must stay untagged.
pub(crate) fn is_launch_refusal(detail: &str) -> bool {
    const REFUSALS: [&str; 10] = [
        "no such file or directory",
        "program not found",
        "permission denied",
        "exec format error",
        "cannot find the file specified",
        "cannot find the path specified",
        "access is denied",
        "is not a valid win32 application",
        "is not recognized as an internal or external command",
        "command not found",
    ];
    let lower = detail.to_ascii_lowercase();
    REFUSALS.iter().any(|needle| lower.contains(needle))
}
