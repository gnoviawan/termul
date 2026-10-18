//! The canvas call router: the parent-side half of the agent gateway (spine
//! AD-19, AD-21, AD-29, AD-30, AD-31).
//!
//! A canvas tool call arrives from the `host_mcp` child's `Bridge` as a
//! `Canvas` frame. The parent resolves the session's project and hands the
//! call to [`CanvasRouter::call`], which forwards it to the renderer that holds
//! that project's mount and waits for the reply. The gateway is the only
//! place a canvas call times out. It keeps no document or selection state:
//! params and results pass through as JSON text.
//!
//! The mounts live in one registry, `canvas::persistence` (AD-19): the host
//! creates a mount on open and removes it through the AD-31 close sequence.
//! Renderers report which connection runs each mount (`canvas_mount` /
//! `canvas_unmount` on `/ws`, the same protocol on the desktop Channel and the
//! web socket); a report for a mount the host does not hold is refused. Until
//! the E2-4 lease exists, the newest report wins. A connection replaced, an
//! unmount report, the connection closing, or the mount closing resolves
//! every call in flight over it with `CANVAS_CLOSED`; a closing mount
//! refuses new calls with `CANVAS_CLOSING`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::canvas::persistence::{CanvasPersistence, ReplyMatch};

/// `canvas.call_timeout_ms` default (AD-29).
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_millis(10_000);

/// Top-level type of the parent → renderer frame on `/ws`.
pub const CANVAS_CALL_TYPE: &str = "canvas_call";

/// Typed canvas error codes (integration contracts, "Typed errors").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CanvasErrorCode {
    CanvasClosed,
    CanvasClosing,
    CanvasHidden,
    CanvasOpenElsewhere,
    CanvasTimeout,
    UnsupportedInKiosk,
    UnknownMethod,
    EngineError,
}

impl CanvasErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CanvasClosed => "CANVAS_CLOSED",
            Self::CanvasClosing => "CANVAS_CLOSING",
            Self::CanvasHidden => "CANVAS_HIDDEN",
            Self::CanvasOpenElsewhere => "CANVAS_OPEN_ELSEWHERE",
            Self::CanvasTimeout => "CANVAS_TIMEOUT",
            Self::UnsupportedInKiosk => "UNSUPPORTED_IN_KIOSK",
            Self::UnknownMethod => "UNKNOWN_METHOD",
            Self::EngineError => "ENGINE_ERROR",
        }
    }

    /// A wire code; anything outside the contract set is an `ENGINE_ERROR`.
    #[must_use]
    pub fn parse(code: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(code.to_string()))
            .unwrap_or(Self::EngineError)
    }
}

/// `{code, message}`, the error half of every canvas reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanvasError {
    pub code: CanvasErrorCode,
    pub message: String,
}

impl CanvasError {
    #[must_use]
    pub fn new(code: CanvasErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The `Err(String)` figcraft's `Backend` carries: the JSON encoding of
    /// `{code, message}`.
    #[must_use]
    pub fn to_backend_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(
                r#"{{"code":"{}","message":"unencodable"}}"#,
                self.code.as_str()
            )
        })
    }
}

/// A forwarded call's outcome: the result's JSON text, or a typed error.
pub type CanvasOutcome = Result<String, CanvasError>;

/// Parent → renderer: `{"type":"canvas_call", callId, projectId, mountSeq,
/// method, params}`. `params` is JSON text the renderer forwards unparsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCallFrame {
    #[serde(rename = "type")]
    type_: &'static str,
    pub call_id: u64,
    pub project_id: String,
    pub mount_seq: u64,
    pub method: String,
    pub params: String,
}

/// Renderer → parent `canvas_reply` payload: `{callId, mountSeq, ok, result}`
/// or `{callId, mountSeq, ok: false, error: {code, message}}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasReplyPayload {
    pub call_id: u64,
    pub mount_seq: u64,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub error: Option<CanvasReplyError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CanvasReplyError {
    pub code: String,
    pub message: String,
}

impl CanvasReplyPayload {
    /// Parse the wire reply into an outcome. An `ok` reply without a result is
    /// malformed; an unknown error code is an `ENGINE_ERROR`.
    pub fn into_outcome(self) -> CanvasOutcome {
        match (self.ok, self.result, self.error) {
            (true, Some(result), _) => Ok(result),
            (false, _, Some(error)) => Err(CanvasError::new(
                CanvasErrorCode::parse(&error.code),
                error.message,
            )),
            _ => Err(CanvasError::new(
                CanvasErrorCode::EngineError,
                "malformed reply from the canvas renderer",
            )),
        }
    }
}

/// `canvas_mount` / `canvas_unmount` payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMountPayload {
    pub project_id: String,
    pub mount_seq: u64,
}

/// Hands a frame to the renderer connection. `false` means it was not queued
/// (the connection is gone or its queue is full).
pub type Deliver = Arc<dyn Fn(CanvasCallFrame) -> bool + Send + Sync>;

/// A renderer connection that can hold mounts.
#[derive(Clone)]
pub struct CanvasHolder {
    id: String,
    deliver: Deliver,
}

impl CanvasHolder {
    #[must_use]
    pub fn new(id: impl Into<String>, deliver: Deliver) -> Self {
        Self {
            id: id.into(),
            deliver,
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Queue `frame` on the connection; false when it was not queued.
    #[must_use]
    pub fn deliver(&self, frame: CanvasCallFrame) -> bool {
        (self.deliver)(frame)
    }
}

impl CanvasCallFrame {
    #[must_use]
    pub fn new(
        call_id: u64,
        project_id: &str,
        mount_seq: u64,
        method: &str,
        params: String,
    ) -> Self {
        Self {
            type_: CANVAS_CALL_TYPE,
            call_id,
            project_id: project_id.to_string(),
            mount_seq,
            method: method.to_string(),
            params,
        }
    }
}

/// The registry this router reads. Production shares the process registry
/// with the canvas transports; unit tests each get their own so parallel
/// tests never share a project's mount.
fn default_mounts() -> Arc<CanvasPersistence> {
    #[cfg(not(test))]
    {
        Arc::clone(crate::canvas::persistence::canvas_mounts())
    }
    #[cfg(test)]
    {
        Arc::new(CanvasPersistence::default())
    }
}

/// Routes canvas calls to the renderer holding each project's mount. The
/// mounts and the calls waiting on them live in the canvas persistence
/// registry (AD-19); this is the gateway's front: the call timeout and the
/// boundary logs.
pub struct CanvasRouter {
    mounts: Arc<CanvasPersistence>,
    call_timeout_ms: AtomicU64,
}

impl Default for CanvasRouter {
    fn default() -> Self {
        Self::new(DEFAULT_CALL_TIMEOUT)
    }
}

impl CanvasRouter {
    #[must_use]
    pub fn new(call_timeout: Duration) -> Self {
        Self::with_mounts(default_mounts(), call_timeout)
    }

    #[must_use]
    pub fn with_mounts(mounts: Arc<CanvasPersistence>, call_timeout: Duration) -> Self {
        Self {
            mounts,
            call_timeout_ms: AtomicU64::new(duration_ms(call_timeout)),
        }
    }

    /// The mount registry calls are routed through.
    #[must_use]
    pub fn mounts(&self) -> &Arc<CanvasPersistence> {
        &self.mounts
    }

    /// `canvas.call_timeout_ms`: how long a forwarded call waits for its reply.
    pub fn set_call_timeout(&self, timeout: Duration) {
        self.call_timeout_ms
            .store(duration_ms(timeout), Ordering::Relaxed);
    }

    /// `holder` reports it runs `project_id`'s canvas at `mount_seq`. Calls in
    /// flight over a previous connection resolve `CANVAS_CLOSED`. False when
    /// the host has no such mount (a stale or unknown `mountSeq`).
    pub fn mount(&self, project_id: &str, mount_seq: u64, holder: CanvasHolder) -> bool {
        let holder_id = holder.id().to_string();
        let attached = self.mounts.attach(project_id, mount_seq, holder);
        if attached {
            log::info!(
                "[canvas-gateway] project {project_id} mountSeq={mount_seq} runs in connection {holder_id}"
            );
        } else {
            log::warn!(
                "[canvas-gateway] project {project_id} mountSeq={mount_seq} refused: the host holds no such mount"
            );
        }
        attached
    }

    /// `holder_id` no longer runs `project_id`'s canvas at `mount_seq`.
    /// Returns whether it did. The mount itself stays until it is closed.
    pub fn unmount(&self, project_id: &str, holder_id: &str, mount_seq: u64) -> bool {
        let detached = self.mounts.detach(project_id, holder_id, mount_seq);
        if detached {
            log::info!(
                "[canvas-gateway] project {project_id} mountSeq={mount_seq} left its connection"
            );
        }
        detached
    }

    /// The holder's connection ended: it runs no canvas any more and its
    /// calls resolve `CANVAS_CLOSED`.
    pub fn release_holder(&self, holder_id: &str) {
        for project in self.mounts.release_holder(holder_id) {
            log::info!("[canvas-gateway] project {project} has no renderer: its connection closed");
        }
    }

    /// A renderer answered `call_id`. Returns whether a waiting call was
    /// resolved.
    pub fn reply(
        &self,
        holder_id: &str,
        call_id: u64,
        mount_seq: u64,
        outcome: CanvasOutcome,
    ) -> bool {
        match self.mounts.reply(holder_id, call_id, mount_seq, outcome) {
            ReplyMatch::Resolved => true,
            ReplyMatch::StaleMount { sent_to } => {
                log::warn!(
                    "[canvas-gateway] reply came from mountSeq={mount_seq}, call was sent to mountSeq={sent_to}"
                );
                true
            }
            ReplyMatch::NotWaiting => false,
        }
    }

    /// Forward `method` with `params` (JSON text) to the renderer holding
    /// `project_id`'s mount and wait for its reply, up to the call timeout.
    pub async fn call(&self, project_id: &str, method: &str, params: String) -> CanvasOutcome {
        let timeout_ms = self.call_timeout_ms.load(Ordering::Relaxed);
        let outcome = self
            .mounts
            .call(
                project_id,
                method,
                params,
                Duration::from_millis(timeout_ms),
            )
            .await;
        if let Err(error) = &outcome {
            if matches!(
                error.code,
                CanvasErrorCode::CanvasClosed
                    | CanvasErrorCode::CanvasClosing
                    | CanvasErrorCode::CanvasTimeout
            ) {
                log::warn!(
                    "[canvas-gateway] {method} for project {project_id} refused: {} ({})",
                    error.code.as_str(),
                    error.message
                );
            }
        }
        outcome
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
