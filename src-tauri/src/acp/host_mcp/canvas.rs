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
//! web socket). Only the renderer holding the mount's lease (AD-30) can
//! report it; any other report is refused, so calls reach the lease holder
//! only. A connection replaced, an unmount report, the connection closing,
//! or the mount closing resolves every call in flight over it with
//! `CANVAS_CLOSED`; a closing mount refuses new calls with `CANVAS_CLOSING`.
//! A holder whose connection closed keeps the lease for the mount's grace;
//! after that the mount is dropped.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use crate::canvas::persistence::RendererId;
use crate::canvas::persistence::{CallFailed, CanvasPersistence, ReplyMatch, SliceMatch};

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

    /// What an agent that got this code should do next, appended to the
    /// message it reads. Agents cannot open, show or move the canvas, so most
    /// steps go through the user.
    #[must_use]
    pub const fn next_step(self) -> Option<&'static str> {
        match self {
            Self::CanvasClosed => Some(
                "The canvas is not open: ask the user to open it with the Canvas button in \
                 Termul's left rail, then retry.",
            ),
            Self::CanvasClosing => Some(
                "The canvas is closing: ask the user to reopen it with the Canvas button in \
                 Termul's left rail, then retry.",
            ),
            Self::CanvasHidden => Some(
                "This tool needs the canvas on screen: ask the user to switch to the Canvas tab, \
                 or use create_node, set_properties, run_command and screenshot, which work \
                 while it is hidden.",
            ),
            Self::CanvasOpenElsewhere => Some(
                "This project's canvas is held by another Termul window or browser tab: ask the \
                 user to close it there and reopen it with the Canvas button here, then retry.",
            ),
            Self::CanvasTimeout => Some(
                "The canvas may still be running this call and apply it after this error, so \
                 do not retry it blindly: read the current state with get_node or \
                 inspect_document first and redo only what did not happen. If reads time out \
                 too, ask the user to check that the Canvas tab is open and responsive.",
            ),
            Self::UnsupportedInKiosk => Some(
                "Termul owns the canvas file: save with save_file, export only to a relative \
                 path inside the project, and never open or write design files on disk.",
            ),
            Self::UnknownMethod | Self::EngineError => None,
        }
    }

    /// [`Self::next_step`] for an error the agent's `tool` got. The editor
    /// cannot be interrupted, so a call that timed out may still finish: a
    /// change still applies (a blind retry applies it twice), and a render
    /// that was too large only queues the same work again. Only a read is
    /// safe to retry as is.
    #[must_use]
    pub fn next_step_for(self, tool: Option<&str>) -> Option<&'static str> {
        match (self, tool) {
            (
                Self::CanvasTimeout,
                Some("get_node" | "inspect_document" | "list_commands" | "inspect_ui"),
            ) => Some(
                "The canvas did not answer in time: retry once, and if it times out again ask \
                 the user to check that the Canvas tab is open and responsive.",
            ),
            (Self::CanvasTimeout, Some("export")) => Some(
                "The export is larger than the canvas can render in time. Do not retry it as \
                 is: export at a smaller `scale` or `size`, or fewer layers. If a small export \
                 times out too, ask the user to check that the Canvas tab is open and responsive.",
            ),
            (Self::CanvasTimeout, Some("screenshot")) => Some(
                "The render is larger than the canvas can draw in time. Do not retry it as is: \
                 take the screenshot with a smaller `maxSize` or `scale`, or fewer layers. If a \
                 small one times out too, ask the user to check that the Canvas tab is open and \
                 responsive.",
            ),
            _ => self.next_step(),
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
    /// `{code, message}`, the message ending in the code's
    /// [`CanvasErrorCode::next_step`]. This string is what the agent reads.
    #[must_use]
    pub fn to_backend_string(&self) -> String {
        self.to_backend_string_for(None)
    }

    /// [`Self::to_backend_string`] for an error the agent's `tool` got
    /// ([`CanvasErrorCode::next_step_for`]).
    #[must_use]
    pub fn to_backend_string_for(&self, tool: Option<&str>) -> String {
        let mut error = self.clone();
        if let Some(step) = self.code.next_step_for(tool) {
            let stop = if error.message.ends_with('.') {
                ""
            } else {
                "."
            };
            error.message = format!("{}{stop} {step}", error.message);
        }
        serde_json::to_string(&error).unwrap_or_else(|_| {
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
/// method, params, timeoutMs?}`. `params` is JSON text the renderer forwards
/// unparsed. `timeoutMs` is how long the host still waits for the reply: a
/// call still queued for a loading editor once it passed is answered
/// `CANVAS_TIMEOUT` without running, so a retry after the host's timeout
/// cannot apply twice. A notice nobody waits for has none.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
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
    /// `result` is a slice that more slices follow, not the whole result.
    #[serde(default)]
    pub partial: bool,
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

/// Host → renderer `{"type":"canvas_lease_lost", projectId, mountSeq, reason}`:
/// the mount at `mountSeq` was saved and unmounted, because another renderer
/// opened the canvas (AD-30) or the mount cap evicted it (AD-26).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLeaseLostFrame {
    #[serde(rename = "type")]
    type_: &'static str,
    pub project_id: String,
    pub mount_seq: u64,
    pub reason: LeaseLostReason,
}

/// Why a renderer lost its mount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LeaseLostReason {
    /// Another renderer opened the canvas and holds it now.
    TakenOver,
    /// The mount cap unloaded it to make room for another canvas.
    Evicted,
}

/// Top-level type of [`CanvasLeaseLostFrame`].
pub const CANVAS_LEASE_LOST_TYPE: &str = "canvas_lease_lost";

/// Hands a frame to the renderer connection. `false` means it was not queued
/// (the connection is gone or its queue is full).
pub type Deliver = Arc<dyn Fn(CanvasCallFrame) -> bool + Send + Sync>;

/// Tells the renderer connection it lost a lease; `false` as for [`Deliver`].
pub type NotifyLeaseLost = Arc<dyn Fn(CanvasLeaseLostFrame) -> bool + Send + Sync>;

/// A renderer connection that can hold mounts: connection `id`, run by
/// `renderer`, the lease identity that outlives the connection.
#[derive(Clone)]
pub struct CanvasHolder {
    id: String,
    renderer: RendererId,
    deliver: Deliver,
    lease_lost: Option<NotifyLeaseLost>,
}

impl CanvasHolder {
    #[must_use]
    pub fn new(id: impl Into<String>, renderer: RendererId, deliver: Deliver) -> Self {
        Self {
            id: id.into(),
            renderer,
            deliver,
            lease_lost: None,
        }
    }

    #[must_use]
    pub fn with_lease_notice(mut self, notify: NotifyLeaseLost) -> Self {
        self.lease_lost = Some(notify);
        self
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn renderer(&self) -> &RendererId {
        &self.renderer
    }

    /// Queue `frame` on the connection; false when it was not queued.
    #[must_use]
    pub fn deliver(&self, frame: CanvasCallFrame) -> bool {
        (self.deliver)(frame)
    }

    /// Tell the connection its mount of `project_id` at `mount_seq` was saved
    /// and unmounted for `reason`; false when it was not queued.
    pub fn tell_lease_lost(
        &self,
        project_id: &str,
        mount_seq: u64,
        reason: LeaseLostReason,
    ) -> bool {
        self.lease_lost.as_ref().is_some_and(|notify| {
            notify(CanvasLeaseLostFrame {
                type_: CANVAS_LEASE_LOST_TYPE,
                project_id: project_id.to_string(),
                mount_seq,
                reason,
            })
        })
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
            timeout_ms: None,
        }
    }

    /// The frame of a call the host waits `left` more for.
    #[must_use]
    pub fn expiring_in(mut self, left: Duration) -> Self {
        self.timeout_ms = Some(duration_ms(left).max(1));
        self
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
    #[must_use]
    pub fn call_timeout(&self) -> Duration {
        Duration::from_millis(self.call_timeout_ms.load(Ordering::Relaxed))
    }

    /// Set `canvas.call_timeout_ms`.
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
                "[canvas-gateway] project {project_id} mountSeq={mount_seq} refused for connection {holder_id}: the host holds no such mount, or another renderer holds its lease"
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

    /// The holder's connection ended: the calls it was handed resolve
    /// `CANVAS_CLOSED`, and each mount it ran is dropped unless its renderer
    /// takes it up again within the mount's lease grace (AD-30). Calls that
    /// arrive within the grace wait for that.
    pub fn release_holder(&self, holder_id: &str) {
        let lost = self.mounts.release_holder(holder_id);
        if lost.is_empty() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::warn!("[canvas-gateway] connection {holder_id} closed outside a runtime; its canvas leases are kept");
            return;
        };
        for lease in lost {
            log::info!(
                "[canvas-gateway] project {} mountSeq={} lost its connection; lease kept for {} ms",
                lease.project_id,
                lease.mount_seq,
                lease.grace.as_millis()
            );
            let mounts = Arc::clone(&self.mounts);
            runtime.spawn(async move {
                tokio::time::sleep(lease.grace).await;
                if let Some(expired) = mounts.expire_lease(&lease.project_id, lease.mount_seq) {
                    log::warn!(
                        "[canvas-gateway] project {} mountSeq={} lease released after {} ms grace: unmounted, last autosave stands saved={} unsaved_dropped={}",
                        lease.project_id,
                        lease.mount_seq,
                        lease.grace.as_millis(),
                        expired.saved_version.as_deref().unwrap_or("none"),
                        expired.unsaved
                    );
                }
            });
        }
    }

    /// A renderer sent a slice of its reply to `call_id` that is not the last
    /// (the wire carries one message at a time, and a long result does not fit
    /// one). Returns whether the slice was taken: false once the call is gone
    /// or the reply passed the limit, and the renderer should stop sending.
    pub fn reply_slice(&self, holder_id: &str, call_id: u64, slice: &str) -> bool {
        match self.mounts.push_reply_slice(holder_id, call_id, slice) {
            SliceMatch::Buffered => true,
            SliceMatch::NotWaiting => false,
            SliceMatch::TooLarge => {
                log::warn!("[canvas-gateway] reply to call {call_id} refused: past the size limit");
                false
            }
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
        self.call_within(project_id, method, params, self.call_timeout())
            .await
    }

    /// [`Self::call`] waiting up to `timeout` instead.
    pub async fn call_within(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> CanvasOutcome {
        let outcome = self.mounts.call(project_id, method, params, timeout).await;
        if let Err(error) = &outcome {
            log_refusal(project_id, method, error);
        }
        outcome
    }

    /// [`Self::call_within`], except that a call the editor received but
    /// did not answer in time hands back its late answer.
    pub async fn call_keeping_late(
        &self,
        project_id: &str,
        method: &str,
        params: String,
        timeout: Duration,
    ) -> Result<String, CallFailed> {
        let outcome = self
            .mounts
            .call_keeping_late(project_id, method, params, timeout)
            .await;
        if let Err(failed) = &outcome {
            log_refusal(project_id, method, &failed.error);
        }
        outcome
    }
}

fn log_refusal(project_id: &str, method: &str, error: &CanvasError) {
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

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
