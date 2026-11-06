//! Reader handoff: strip session frames before buffering client output.

use std::sync::{Arc, Mutex};

use super::filter::{FilterResult, SessionFilter};
use super::frame::Frame;
use super::gate::SessionGate;
use super::suppression::SuppressionEndReason;
use crate::pty::manager::{MAX_PENDING, OVERFLOW_NOTICE};
use crate::trackers::terminal_events::{TerminalEvent, TerminalEventHub};

/// Delivers completion output to the gate and buffers only terminal bytes.
/// Returns false when the pending buffer is poisoned so the reader can exit.
pub fn process_reader_chunk(
    filter: &mut SessionFilter,
    chunk: &[u8],
    pending: &Mutex<Vec<u8>>,
    gate: &Arc<SessionGate>,
    terminal_id: &str,
    hub: &TerminalEventHub,
) -> bool {
    bind_trust_loss_sink(gate, terminal_id, hub);
    let bytes = filter_chunk_bytes(filter, chunk, gate, terminal_id, hub);
    let bytes = filter.space_prompts(&bytes);
    let mut guard = match pending.lock() {
        Ok(guard) => guard,
        Err(error) => {
            log::error!(
                "[PTY {}] Pending buffer mutex poisoned: {}",
                terminal_id,
                error
            );
            return false;
        }
    };
    if guard.len() + bytes.len() > MAX_PENDING {
        guard.clear();
        guard.extend_from_slice(OVERFLOW_NOTICE);
        log::warn!(
            "[PTY {}] Output buffer overflow — dropped data",
            terminal_id
        );
    } else {
        guard.extend_from_slice(&bytes);
    }
    true
}

fn filter_chunk_bytes(
    filter: &mut SessionFilter,
    chunk: &[u8],
    gate: &Arc<SessionGate>,
    terminal_id: &str,
    hub: &TerminalEventHub,
) -> Vec<u8> {
    if !gate.suppressing_output() && !gate.awaiting_registration() {
        return process_piece(filter, chunk, gate, terminal_id, hub);
    }
    let mut forwarded = Vec::new();
    for piece in chunk.split_inclusive(|&b| b == 0x07 || b == b'\\') {
        let was_suppressing = gate.suppressing_output();
        let bytes = process_piece(filter, piece, gate, terminal_id, hub);
        if !was_suppressing {
            forwarded.extend_from_slice(&bytes);
        }
    }
    forwarded
}

fn process_piece(
    filter: &mut SessionFilter,
    piece: &[u8],
    gate: &Arc<SessionGate>,
    terminal_id: &str,
    hub: &TerminalEventHub,
) -> Vec<u8> {
    filter.set_registered_nonce(gate.session_identity().map(|(_, nonce)| nonce));
    match filter.process(piece) {
        FilterResult::Forwarded { bytes, frames } => {
            gate.observe_output(&bytes);
            for frame in frames {
                publish_frame(frame, gate, terminal_id, hub);
            }
            bytes
        }
        FilterResult::Desync { bytes } => {
            gate.observe_output(&bytes);
            gate.notify_trust_loss(SuppressionEndReason::TrustLost);
            bytes
        }
    }
}

fn publish_frame(frame: Frame, gate: &SessionGate, terminal_id: &str, hub: &TerminalEventHub) {
    // Completion delivery may notify after releasing its own locks.
    if let Frame::Completion(result) = frame {
        gate.finish_completion(result);
        log::trace!("[PTY {terminal_id}] Session completion frame delivered");
        return;
    }
    let _publication = gate.publication.lock();
    match frame {
        Frame::InitShell { session_id, nonce } => {
            if !gate.register_session(session_id.clone(), nonce.clone()) {
                return;
            }
            emit_lifecycle(
                gate,
                hub,
                terminal_id,
                session_id,
                "InitShell",
                nonce,
                None,
                None,
                false,
                false,
                None,
            );
        }
        other => publish_authenticated_frame(other, gate, terminal_id, hub),
    }
}

type LifecycleFields = (
    &'static str,
    String,
    Option<u64>,
    Option<String>,
    bool,
    bool,
    Option<i32>,
);

fn lifecycle_fields(frame: Frame) -> Option<LifecycleFields> {
    Some(match frame {
        Frame::PromptReady {
            nonce,
            prompt_generation,
            cwd,
            line_empty,
            prompt_suppressed,
        } => (
            "PromptReady",
            nonce,
            Some(prompt_generation),
            Some(cwd),
            line_empty,
            prompt_suppressed,
            None,
        ),
        Frame::CommandStarted { nonce: Some(nonce) } => {
            ("CommandStarted", nonce, None, None, false, false, None)
        }
        Frame::CommandFinished {
            nonce: Some(nonce),
            exit_code,
        } => (
            "CommandFinished",
            nonce,
            None,
            None,
            false,
            false,
            exit_code,
        ),
        _ => return None,
    })
}

fn publish_authenticated_frame(
    frame: Frame,
    gate: &SessionGate,
    terminal_id: &str,
    hub: &TerminalEventHub,
) {
    // The filter has already authenticated this frame with the registered nonce.
    let Some((kind, nonce, generation, cwd, line_empty, prompt_suppressed, exit_code)) =
        lifecycle_fields(frame)
    else {
        return;
    };
    let Some((session_id, _)) = gate.session_identity() else {
        return;
    };
    if kind == "PromptReady" {
        if line_empty && prompt_suppressed {
            gate.mark_trusted_prompt(
                generation.expect("prompt generation"),
                cwd.clone().expect("prompt cwd"),
            );
        } else {
            gate.mark_raw();
        }
    }
    if kind == "CommandStarted" {
        // CommandStarted is a completion trust loss; the host stays Running, not Raw.
        gate.mark_running();
        gate.end_suppression(SuppressionEndReason::TrustLost);
    }
    if kind == "CommandFinished" {
        gate.mark_running();
        if let Some(code) = exit_code {
            gate.record_authenticated_exit(terminal_id, code);
        }
    }
    emit_lifecycle(
        gate,
        hub,
        terminal_id,
        session_id,
        kind,
        nonce,
        generation,
        cwd,
        line_empty,
        prompt_suppressed,
        exit_code,
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_lifecycle(
    gate: &SessionGate,
    hub: &TerminalEventHub,
    terminal_id: &str,
    session_id: String,
    kind: &str,
    nonce: String,
    prompt_generation: Option<u64>,
    cwd: Option<String>,
    line_empty: bool,
    prompt_suppressed: bool,
    exit_code: Option<i32>,
) {
    log::debug!("[PTY {terminal_id}] Session lifecycle kind={kind}");
    gate.publish_event(
        hub,
        TerminalEvent::SessionLifecycle {
            lifecycle_sequence: None,
            terminal_id: terminal_id.to_owned(),
            session_id,
            kind: kind.to_owned(),
            nonce: Some(nonce),
            prompt_generation,
            cwd,
            line_empty,
            prompt_suppressed,
            exit_code,
        },
    );
}

fn bind_trust_loss_sink(gate: &Arc<SessionGate>, terminal_id: &str, hub: &TerminalEventHub) {
    if gate.has_trust_loss_sink() {
        return;
    }
    let weak = Arc::downgrade(gate);
    let terminal_id = terminal_id.to_owned();
    let hub = hub.clone();
    gate.install_trust_loss_sink(Arc::new(move |reason| {
        let Some(gate) = weak.upgrade() else {
            return;
        };
        restore_after_trust_loss(&gate, &terminal_id, &hub, reason);
    }));
}

fn restore_after_trust_loss(
    gate: &Arc<SessionGate>,
    terminal_id: &str,
    hub: &TerminalEventHub,
    reason: SuppressionEndReason,
) {
    let publication = gate.publication.lock();
    // Raw PTYs have no authenticated integration key bindings to restore.
    if gate.session_identity().is_none() {
        gate.mark_raw();
        return;
    }
    if reason == SuppressionEndReason::DrainTimeout {
        // A newer authenticated prompt supersedes this deferred notification.
        if gate.trusted_at_prompt() {
            return;
        }
    } else {
        gate.mark_raw();
    }
    if reason == SuppressionEndReason::Watchdog {
        gate.end_suppression(reason);
    }
    gate.begin_desync_restore();
    log::warn!("[PTY {terminal_id}] Session desync; restoring shell prompt");
    emit_desync(gate, terminal_id, hub);
    drop(publication);
    spawn_prompt_restore(gate, terminal_id);
}

fn spawn_prompt_restore(gate: &Arc<SessionGate>, terminal_id: &str) {
    let restoring_gate = gate.clone();
    let restoring_id = terminal_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            restoring_gate.restore_prompt(true),
        )
        .await;
        if !matches!(result, Ok(super::frame::SessionRpcResult::Accepted)) {
            log::warn!("[PTY {restoring_id}] Desync prompt restore failed: {result:?}");
        }
    });
}

fn emit_desync(gate: &SessionGate, terminal_id: &str, hub: &TerminalEventHub) {
    let Some((session_id, nonce)) = gate.session_identity() else {
        return;
    };
    gate.publish_event(
        hub,
        TerminalEvent::SessionLifecycle {
            lifecycle_sequence: None,
            terminal_id: terminal_id.to_owned(),
            session_id,
            kind: "Desync".to_owned(),
            nonce: Some(nonce),
            prompt_suppressed: false,
            line_empty: false,
            exit_code: None,
            prompt_generation: None,
            cwd: None,
        },
    );
}
