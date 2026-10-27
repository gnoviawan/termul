//! Session RPC names requiring terminal write capability.

pub(crate) const SUBMIT: &str = "command_editor_submit";
pub(crate) const REQUEST_COMPLETION: &str = "command_editor_request_completion";
pub(crate) const CANCEL_COMPLETION: &str = "command_editor_cancel_completion";
pub(crate) const RESTORE_PROMPT: &str = "command_editor_restore_prompt";
#[cfg(test)]
pub(crate) const SESSION_RPC_NAMES: [&str; 3] = [SUBMIT, REQUEST_COMPLETION, CANCEL_COMPLETION];

use super::*;
use crate::pty::session_protocol::gate::{AuthenticSession, CompletionRequest, SessionPhase};
use crate::pty::session_protocol::rpc;
use crate::trackers::terminal_events::TerminalEvent;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

type Failure = (&'static str, String);

pub(super) async fn restore_prompt(
    request: &Request,
    state: &AppState,
    ctx: &ConnectionContext,
) -> Result<Value, Failure> {
    let terminal_id = authorized_terminal_id(request, ctx)?;
    tracing::debug!("[command-editor] restore prompt received terminal_id={terminal_id}");
    let result = rpc::restore_prompt(&state.pty, terminal_id, ctx.capabilities.write).await;
    serde_json::to_value(result).map_err(|e| ("RESTORE_PROMPT_FAILED", e.to_string()))
}

pub(super) async fn submit(
    request: &Request,
    state: &AppState,
    ctx: &ConnectionContext,
) -> Result<Value, Failure> {
    let terminal_id = authorized_terminal_id(request, ctx)?;
    // Empty drafts are valid strings; their meaning belongs to the session gate.
    let draft = request.payload["draft"]
        .as_str()
        .ok_or(("INVALID_PAYLOAD", "Missing or invalid draft".to_string()))?;
    tracing::debug!("[command-editor] submit received terminal_id={terminal_id}");
    let result = rpc::submit(&state.pty, terminal_id, draft, ctx.capabilities.write).await;
    serde_json::to_value(result).map_err(|e| ("SUBMIT_FAILED", e.to_string()))
}

pub(super) async fn request_completion(
    request: &Request,
    state: &AppState,
    ctx: &ConnectionContext,
    tx: &mpsc::Sender<Message>,
) -> Result<Value, Failure> {
    let terminal_id = authorized_terminal_id(request, ctx)?;
    let mut completion: CompletionRequest = serde_json::from_value(request.payload.clone())
        .map_err(|_| ("INVALID_PAYLOAD", "Invalid completion request".to_string()))?;
    tracing::debug!("[command-editor] completion admission terminal_id={terminal_id}");
    let local_id = completion.request_id.clone();
    completion.request_id = rpc::owned_request_id(&ctx.client_id, &local_id);
    let start =
        rpc::admit_completion(&state.pty, terminal_id, &completion, ctx.capabilities.write).await;
    queue_completion_wait(
        ctx.client_id.clone(),
        request.id.clone(),
        local_id,
        start,
        tx.clone(),
    );
    Ok(Value::Null) // The request loop skips this marker; the spawned wait sends the real reply.
}

pub(super) async fn cancel_completion(
    request: &Request,
    state: &AppState,
    ctx: &ConnectionContext,
) -> Result<Value, Failure> {
    let terminal_id = authorized_terminal_id(request, ctx)?;
    let request_id = string_field(&request.payload, "requestId")?;
    tracing::debug!("[command-editor] completion cancellation received terminal_id={terminal_id}");
    let owned_id = rpc::owned_request_id(&ctx.client_id, request_id);
    let result = rpc::cancel_completion(&state.pty, terminal_id, &owned_id).await;
    serde_json::to_value(result).map_err(|e| ("CANCEL_COMPLETION_FAILED", e.to_string()))
}

fn authorized_terminal_id<'a>(
    request: &'a Request,
    ctx: &ConnectionContext,
) -> Result<&'a str, Failure> {
    let terminal_id = string_field(&request.payload, "terminalId")?;
    if !ctx.is_authorized(terminal_id) {
        return Err((
            "UNAUTHORIZED",
            format!("Not authorized for terminal {terminal_id}"),
        ));
    }
    Ok(terminal_id)
}

#[derive(Default)]
struct ConnectionWork {
    order: Arc<tokio::sync::Mutex<()>>,
    waits: HashMap<u64, tokio::task::AbortHandle>,
}

type WorkRegistry = parking_lot::Mutex<HashMap<String, ConnectionWork>>;

fn completion_work() -> &'static WorkRegistry {
    static WORK: std::sync::OnceLock<WorkRegistry> = std::sync::OnceLock::new();
    WORK.get_or_init(WorkRegistry::default)
}

/// Admit one socket request without blocking a later cancel on an in-flight completion.
pub(super) async fn serve_request(
    request: Request,
    state: &AppState,
    tx: &mpsc::Sender<Message>,
    ctx: &mut ConnectionContext,
    stop: &CancellationToken,
) -> Option<()> {
    let id = request.id.clone();
    let op_type = request.type_.clone();
    info!("[terminal-ws] request start type={op_type} id={id}");
    let _reply_order = reply_guard(&ctx.client_id).await;
    let handled = tokio::select! {
        biased;
        () = stop.cancelled() => return None,
        handled = super::handle(request, state, tx, ctx) => handled,
    };
    match handled {
        Ok(data) => {
            if op_type == REQUEST_COMPLETION {
                return Some(());
            }
            info!("[terminal-ws] request success type={op_type} id={id}");
            send_json(tx, json!({ "id": id, "success": true, "data": data }))
                .await
                .ok()?;
        }
        Err((code, message)) => {
            warn!("[terminal-ws] request failed type={op_type} id={id} code={code}");
            send_error(tx, &id, code, message).await.ok()?;
        }
    }
    Some(())
}

/// Hold through a serial request's reply so cancel's acknowledgement precedes its completion reply.
pub(super) async fn reply_guard(owner: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let order = completion_work()
        .lock()
        .entry(owner.to_owned())
        .or_default()
        .order
        .clone();
    order.lock_owned().await
}

struct WaitCleanup {
    owner: String,
    key: u64,
}

impl Drop for WaitCleanup {
    fn drop(&mut self) {
        if let Some(work) = completion_work().lock().get_mut(&self.owner) {
            work.waits.remove(&self.key);
        }
    }
}

fn queue_completion_wait(
    owner: String,
    reply_id: String,
    local_id: String,
    start: crate::pty::session_protocol::gate::CompletionStart,
    tx: mpsc::Sender<Message>,
) {
    static NEXT_WAIT: AtomicU64 = AtomicU64::new(1);
    let key = NEXT_WAIT.fetch_add(1, Ordering::Relaxed);
    let mut registry = completion_work().lock();
    let work = registry.entry(owner.clone()).or_default();
    let order = work.order.clone();
    let cleanup = WaitCleanup { owner, key };
    let task = tokio::spawn(async move {
        let _cleanup = cleanup;
        let reply = rpc::wait_for_completion(start).await;
        let _order = order.lock_owned().await;
        let reply = rpc::local_completion_reply(reply, local_id);
        tracing::debug!(
            "[command-editor] completion reply outcome={:?}",
            reply.outcome
        );
        if send_json(&tx, json!({"id":reply_id, "success":true, "data":reply}))
            .await
            .is_err()
        {
            tracing::debug!("[command-editor] completion reply channel closed");
        }
    });
    work.waits.insert(key, task.abort_handle());
}

/// Teardown also runs when the host aborts the entire socket future.
pub(super) fn teardown(owner: &str) {
    let work = completion_work().lock().remove(owner);
    if let Some(work) = work {
        tracing::debug!(
            "[command-editor] aborting {} completion waits",
            work.waits.len()
        );
        for task in work.waits.into_values() {
            task.abort();
        }
    }
}

/// Watermarks persist after pending buffers drain: the broadcast receiver may
/// still contain old publications when an attach switches to live forwarding.
#[derive(Default)]
pub(super) struct AttachState {
    pub(super) buffers: HashMap<String, Vec<TerminalEvent>>,
    pub(super) watermarks: HashMap<String, u64>,
    pub(super) overflowed: HashSet<String>,
    #[cfg(test)]
    pub(super) cleanup_hook: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl AttachState {
    pub(super) fn forget(&mut self, terminal_id: &str) {
        self.buffers.remove(terminal_id);
        self.watermarks.remove(terminal_id);
        self.overflowed.remove(terminal_id);
    }
}

/// Match the hub capacity; a slow replay cannot retain unbounded lifecycle data.
const ATTACH_EVENT_CAPACITY: usize = 256;

pub(super) struct PendingAttach {
    registry: AttachRegistry,
    terminal_id: String,
}

impl Drop for PendingAttach {
    fn drop(&mut self) {
        let mut attaching = self.registry.write();
        attaching.buffers.remove(&self.terminal_id);
        attaching.overflowed.remove(&self.terminal_id);
    }
}

pub(super) type AttachRegistry = Arc<parking_lot::RwLock<AttachState>>;

/// Forwards hub events for authorized terminals; buffers SessionLifecycle while attaching.
pub(super) fn spawn_event_forwarder(
    tx: mpsc::Sender<Message>,
    mut event_rx: tokio::sync::broadcast::Receiver<TerminalEvent>,
    authorized: Arc<parking_lot::RwLock<HashSet<String>>>,
    attaching: AttachRegistry,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let received = tokio::select! {
                biased;
                () = tx.closed() => break,
                received = event_rx.recv() => received,
            };
            match received {
                Ok(event) => {
                    if forward_or_buffer_hub_event(&event, &authorized, &attaching, &tx)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!("[terminal-ws] lifecycle event receiver lagged by {skipped}");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

pub(super) async fn forward_or_buffer_hub_event(
    event: &TerminalEvent,
    authorized: &parking_lot::RwLock<HashSet<String>>,
    attaching: &parking_lot::RwLock<AttachState>,
    tx: &mpsc::Sender<Message>,
) -> Result<(), ()> {
    let terminal_id = event.terminal_id();
    if event.lifecycle_sequence().is_some()
        || matches!(event, TerminalEvent::SessionLifecycle { .. })
    {
        let mut attaching = attaching.write();
        if event.lifecycle_sequence().is_some_and(|seq| {
            attaching
                .watermarks
                .get(terminal_id)
                .is_some_and(|floor| seq <= *floor)
        }) {
            return Ok(());
        }
        if attaching.overflowed.contains(terminal_id) {
            return Ok(());
        }
        if let Some(buffer) = attaching.buffers.get_mut(terminal_id) {
            if buffer.len() == ATTACH_EVENT_CAPACITY {
                buffer.clear();
                attaching.overflowed.insert(terminal_id.to_owned());
                tracing::warn!(
                    "[terminal-ws] attach lifecycle buffer overflow terminal_id={terminal_id}"
                );
            } else {
                buffer.push(event.clone());
            }
            return Ok(());
        }
    }
    if !authorized.read().contains(terminal_id) {
        return Ok(());
    }
    let payload = serde_json::to_value(event).unwrap_or_else(|_| json!({}));
    send_json(tx, json!({ "type": "event", "payload": payload }))
        .await
        .map_err(|_| ())
}

impl ConnectionContext {
    /// Mark attaching before authorize so live lifecycle is buffered, not dropped.
    pub(super) fn begin_attach(&mut self, terminal_id: &str) -> PendingAttach {
        let mut attaching = self.attaching.write();
        attaching.watermarks.remove(terminal_id);
        attaching.overflowed.remove(terminal_id);
        attaching
            .buffers
            .insert(terminal_id.to_string(), Vec::new());
        drop(attaching);
        self.authorize(terminal_id);
        PendingAttach {
            registry: self.attaching.clone(),
            terminal_id: terminal_id.to_owned(),
        }
    }

    /// Revoke authorization before overflow state becomes invisible to the forwarder.
    fn take_attach_batch(&self, terminal_id: &str) -> Result<Option<Vec<TerminalEvent>>, String> {
        let mut attaching = self.attaching.write();
        if attaching.overflowed.contains(terminal_id) {
            // Forwarding checks attaching before authorized; use the same order.
            self.authorized.write().remove(terminal_id);
            #[cfg(test)]
            let cleanup_hook = attaching.cleanup_hook.take();
            attaching.forget(terminal_id);
            drop(attaching);
            #[cfg(test)]
            if let Some(hook) = cleanup_hook {
                hook();
            }
            return Err("Attach lifecycle buffer overflow".to_owned());
        }
        match attaching.buffers.get_mut(terminal_id) {
            Some(buffer) if !buffer.is_empty() => Ok(Some(std::mem::take(buffer))),
            _ => {
                attaching.buffers.remove(terminal_id);
                Ok(None)
            }
        }
    }

    /// Flush buffered lifecycle in order, then clear the attaching flag.
    pub(super) async fn finish_attach(
        &mut self,
        tx: &mpsc::Sender<Message>,
        terminal_id: &str,
        sequence: u64,
    ) -> Result<(), String> {
        let _pending = PendingAttach {
            registry: self.attaching.clone(),
            terminal_id: terminal_id.to_owned(),
        };
        self.attaching
            .write()
            .watermarks
            .insert(terminal_id.to_owned(), sequence);
        loop {
            let Some(batch) = self.take_attach_batch(terminal_id)? else {
                return Ok(());
            };
            for event in batch {
                if event
                    .lifecycle_sequence()
                    .is_some_and(|seq| seq <= sequence)
                {
                    continue;
                }
                let payload = serde_json::to_value(&event).unwrap_or_else(|_| json!({}));
                send_json(tx, json!({ "type": "event", "payload": payload })).await?;
            }
        }
    }
}

/// Replay the authentic session so a late attach matches live hub events.
pub(super) async fn send_authentic_session(
    tx: &mpsc::Sender<Message>,
    snapshot: AuthenticSession,
    terminal_id: &str,
) -> Result<u64, String> {
    let sequence = snapshot.sequence;
    for event in authentic_session_events(snapshot, terminal_id) {
        let payload = serde_json::to_value(&event).unwrap_or_else(|_| json!({}));
        send_json(tx, json!({ "type": "event", "payload": payload })).await?;
    }
    Ok(sequence)
}

pub(super) fn authentic_session_events(
    snapshot: AuthenticSession,
    terminal_id: &str,
) -> Vec<TerminalEvent> {
    if snapshot.exited {
        return Vec::new();
    }
    let Some((session_id, nonce)) = snapshot.identity.clone() else {
        return Vec::new();
    };
    let mut events = vec![replay_lifecycle(
        terminal_id,
        session_id.clone(),
        "InitShell",
        nonce.clone(),
        false,
        false,
        None,
        None,
    )];
    if let Some(event) = replay_phase_event(snapshot, terminal_id, session_id, nonce) {
        events.push(event);
    }
    events
}

fn replay_phase_event(
    snapshot: AuthenticSession,
    terminal_id: &str,
    session_id: String,
    nonce: String,
) -> Option<TerminalEvent> {
    match snapshot.phase {
        SessionPhase::AtPrompt if snapshot.prompt.is_some() => {
            snapshot.prompt.map(|(generation, cwd)| {
                replay_lifecycle(
                    terminal_id,
                    session_id,
                    "PromptReady",
                    nonce,
                    true,
                    true,
                    Some(generation),
                    Some(cwd),
                )
            })
        }
        SessionPhase::Running => Some(replay_lifecycle(
            terminal_id,
            session_id,
            "CommandStarted",
            nonce,
            false,
            false,
            None,
            None,
        )),
        SessionPhase::Raw | SessionPhase::AtPrompt => Some(replay_lifecycle(
            terminal_id,
            session_id,
            "Desync",
            nonce,
            false,
            false,
            None,
            None,
        )),
        SessionPhase::Registered => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn replay_lifecycle(
    terminal_id: &str,
    session_id: String,
    kind: &str,
    nonce: String,
    line_empty: bool,
    prompt_suppressed: bool,
    prompt_generation: Option<u64>,
    cwd: Option<String>,
) -> TerminalEvent {
    TerminalEvent::SessionLifecycle {
        lifecycle_sequence: None,
        terminal_id: terminal_id.to_owned(),
        session_id,
        kind: kind.to_owned(),
        nonce: Some(nonce),
        prompt_suppressed,
        line_empty,
        exit_code: None,
        prompt_generation,
        cwd,
    }
}
