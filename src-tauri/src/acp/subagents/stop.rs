//! Stopping one subagent: what the host does for a stop request, decided
//! from the subagent's record alone.

use std::fmt;

use serde::Serialize;

use super::{Subagent, SubagentStop};

/// A stop request that did its job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StopSubagentOutcome {
    /// The host sent the agent `session/cancel` for the child session. The
    /// agent confirms with an idle `cancelled` state on the record.
    Sent,
    /// The subagent's work had already ended; nothing was sent.
    AlreadyEnded,
}

/// A stop request the host refused or could not deliver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StopSubagentError {
    UnknownAgent,
    UnknownSubagent,
    /// The agent does not offer a stop for this subagent right now.
    NotStoppable,
    /// Delivery to the agent failed.
    Failed(String),
}

impl fmt::Display for StopSubagentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownAgent => f.write_str("The agent of this chat is not running"),
            Self::UnknownSubagent => f.write_str("This chat has no such subagent"),
            Self::NotStoppable => f.write_str("The agent does not let Troupe stop this subagent"),
            Self::Failed(error) => write!(f, "Could not reach the agent: {error}"),
        }
    }
}

/// What a stop request for `record` must do.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StopPlan<'a> {
    /// Send `session/cancel` for this child session.
    CancelSession(&'a str),
    AlreadyEnded,
}

/// Decide a stop request from the subagent's current record. An ended
/// subagent is a no-op success, so a repeated stop converges. A working one
/// needs the agent's stop capability; an unobservable one cannot be stopped.
pub(crate) fn stop_plan(record: Option<&Subagent>) -> Result<StopPlan<'_>, StopSubagentError> {
    let record = record.ok_or(StopSubagentError::UnknownSubagent)?;
    if record.state.is_idle() {
        return Ok(StopPlan::AlreadyEnded);
    }
    match record.caps.stop {
        Some(SubagentStop::SessionCancel) if record.state.is_working() => {
            Ok(StopPlan::CancelSession(&record.id))
        }
        _ => Err(StopSubagentError::NotStoppable),
    }
}

#[cfg(test)]
#[path = "stop_tests.rs"]
mod stop_tests;
