//! Per-PTY host gate for session writes.

use std::io::Write;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::{Mutex, ReentrantMutex};
use serde::Deserialize;
use std::cell::Cell;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::bracketed_paste::BracketedPasteTracker;
use super::completion::{CompletionDelivery, CompletionState, PromptSnapshot};
use super::frame::SessionRpcResult;
pub use super::suppression::SuppressionEndReason;
use super::suppression::SuppressionWindow;
use super::{CLEAR_LINE_SEQUENCE, RESTORE_PROMPT_SEQUENCE};
use crate::pty::claims::{ClaimError, ClaimWriteLease};

/// Maximum time submit waits for shell generators to finish before falling back to raw.
pub(crate) const GENERATOR_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Maximum time submit waits for DECSET 2004 when the shell previously enabled it.
pub const BRACKETED_PASTE_WAIT: Duration = Duration::from_millis(250);

/// Host-side session phase the web attach replay reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionPhase {
    /// Registered handshake, no trusted prompt yet.
    #[default]
    Registered,
    /// Empty trusted prompt; replay emits PromptReady.
    AtPrompt,
    /// A command is in flight; replay emits CommandStarted.
    Running,
    /// Trust lost or Desync; replay emits Desync.
    Raw,
}

/// Registered identity plus optional trusted prompt snapshot.
pub struct AuthenticSession {
    pub identity: Option<(String, String)>,
    pub prompt: Option<(u64, String)>,
    pub exited: bool,
    pub sequence: u64,
    pub phase: SessionPhase,
}

#[derive(Clone, Copy, Default)]
pub(super) struct PublicationState {
    sequence: u64,
    pub exited: bool,
    phase: SessionPhase,
    restore_epoch: u64,
    restored_epoch: Option<u64>,
}

/// Completion parameters shared by desktop and websocket session RPCs.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    /// Correlates the completion with its response and cancellation.
    pub request_id: String,
    /// Identifies the draft revision used by this request.
    pub buffer_revision: u64,
    /// Cursor position in the requested draft.
    pub cursor: u64,
    /// Draft whose prefix is passed to the shell generator.
    pub draft: String,
    /// Identifies the shell prompt used by this request.
    pub prompt_generation: u64,
    /// Working directory used for completion.
    pub cwd: String,
}

/// A completion generator the gate may run: opaque command bytes plus whether
/// the provider can restore shell state after it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionProvider {
    /// Identifies the registered provider.
    pub id: String,
    /// Opaque generator command sent to the PTY.
    pub command: Vec<u8>,
    /// Whether the provider can restore shell state after generation.
    pub restorable: bool,
}

/// The outcome of a completion request plus, when it started, the waiter for its result.
#[derive(Debug)]
pub struct CompletionStart {
    /// Whether the generator started or why it was refused.
    pub result: SessionRpcResult,
    /// Receives the payload only for an accepted generator.
    pub waiter: Option<tokio::sync::oneshot::Receiver<CompletionDelivery>>,
    pub(super) epoch: Option<u64>,
}

impl CompletionStart {
    pub(super) fn without_waiter(result: SessionRpcResult) -> Self {
        Self {
            result,
            waiter: None,
            epoch: None,
        }
    }
}

#[derive(Default)]
struct SessionIdentity {
    issued: Option<(String, String)>,
    registered: bool,
}

pub(super) type TrustLossSink = Arc<dyn Fn(SuppressionEndReason) + Send + Sync>;

/// Serializes session writes through the PTY's shared writer lock.
pub struct SessionGate {
    // Publication precedes prompt/completion/identity locks; recursive entry lets
    // lifecycle delivery call the same synchronous state setters as other paths.
    pub(super) publication: ReentrantMutex<Cell<PublicationState>>,
    session_identity: Mutex<SessionIdentity>,
    writer: Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>,
    pub(super) trusted_at_prompt: Mutex<Option<PromptSnapshot>>,
    pub(super) completion: Mutex<CompletionState>,
    completion_providers: Mutex<Vec<CompletionProvider>>,
    pub(super) suppression: SuppressionWindow,
    bracketed_paste: BracketedPasteTracker,
    pub(super) generator_finished: Notify,
    pub(super) trust_loss_sink: OnceLock<TrustLossSink>,
    exit_codes: OnceLock<Arc<crate::trackers::ExitCodeTracker>>,
    /// Test hook: fired immediately before each writer-lock wait so a
    /// regression can revoke the claim while the lock is still held.
    #[cfg(test)]
    pub(crate) about_to_lock_writer: Notify,
}

impl SessionGate {
    /// Creates an untrusted gate using the PTY's existing writer Arc.
    pub fn new(writer: Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>) -> Self {
        Self {
            publication: ReentrantMutex::new(Cell::new(PublicationState::default())),
            session_identity: Mutex::new(SessionIdentity::default()),
            writer,
            trusted_at_prompt: Mutex::new(None),
            completion: Mutex::new(CompletionState::default()),
            completion_providers: Mutex::new(Vec::new()),
            bracketed_paste: BracketedPasteTracker::default(),
            suppression: SuppressionWindow::new(),
            generator_finished: Notify::new(),
            trust_loss_sink: OnceLock::new(),
            exit_codes: OnceLock::new(),
            #[cfg(test)]
            about_to_lock_writer: Notify::new(),
        }
    }

    #[allow(clippy::unused_self)]
    fn notify_about_to_lock_writer(&self) {
        #[cfg(test)]
        self.about_to_lock_writer.notify_waiters();
    }

    /// Hands the PTY's exit-code tracker to lifecycle delivery.
    pub fn bind_exit_code_tracker(&self, tracker: Arc<crate::trackers::ExitCodeTracker>) {
        let _ = self.exit_codes.set(tracker);
    }

    /// Records an authenticated CommandFinished exit code on the bound tracker.
    pub(super) fn record_authenticated_exit(&self, terminal_id: &str, code: i32) {
        if let Some(tracker) = self.exit_codes.get() {
            tracker.record_exit_code(terminal_id, code);
        }
    }

    pub(super) fn set_host_phase(&self, phase: SessionPhase) {
        let publication = self.publication.lock();
        let mut state = publication.get();
        state.phase = phase;
        publication.set(state);
    }

    /// Opens a new restore epoch so the next restore_prompt write is allowed once.
    pub(super) fn begin_desync_restore(&self) {
        let publication = self.publication.lock();
        let mut state = publication.get();
        state.restore_epoch = state.restore_epoch.saturating_add(1);
        state.phase = SessionPhase::Raw;
        publication.set(state);
    }

    /// Installs the hub restore path once, at the reader/hub wiring point.
    pub(super) fn install_trust_loss_sink(&self, sink: TrustLossSink) {
        let _ = self.trust_loss_sink.set(sink);
    }

    /// Whether the hub restore path is already installed.
    pub(super) fn has_trust_loss_sink(&self) -> bool {
        self.trust_loss_sink.get().is_some()
    }

    /// Invokes the trust-loss sink after every gate lock has been released.
    pub(super) fn notify_trust_loss(&self, reason: SuppressionEndReason) {
        if let Some(sink) = self.trust_loss_sink.get() {
            sink(reason);
            return;
        }
        if reason != SuppressionEndReason::DrainTimeout {
            self.mark_raw();
        }
        if reason == SuppressionEndReason::Watchdog {
            self.end_suppression(reason);
        }
    }

    /// Records the identity issued by the host before the reader starts.
    pub fn expect_session(&self, session_id: String, nonce: String) {
        let mut identity = self.session_identity.lock();
        if identity.issued.is_none() {
            identity.issued = Some((session_id, nonce));
        }
    }

    /// Registers only the issued shell identity, accepting its first handshake once.
    pub fn register_session(&self, session_id: String, nonce: String) -> bool {
        let _publication = self.publication.lock();
        let mut identity = self.session_identity.lock();
        if identity.registered || identity.issued.as_ref() != Some(&(session_id, nonce)) {
            log::debug!("[session-gate] Ignoring unissued or repeated InitShell");
            return false;
        }
        identity.registered = true;
        true
    }

    /// Returns the registered shell identity for lifecycle delivery.
    pub fn session_identity(&self) -> Option<(String, String)> {
        let identity = self.session_identity.lock();
        identity
            .registered
            .then(|| identity.issued.clone())
            .flatten()
    }

    /// Whether the reader still needs to authenticate an issued InitShell handshake.
    pub fn awaiting_registration(&self) -> bool {
        let identity = self.session_identity.lock();
        identity.issued.is_some() && !identity.registered
    }

    /// Drops prompt trust immediately when protocol framing is lost.
    pub fn mark_raw(&self) {
        // Publish trust and phase together before any prompt observer can snapshot them.
        let _publication = self.publication.lock();
        *self.trusted_at_prompt.lock() = None;
        self.set_host_phase(SessionPhase::Raw);
        self.end_suppression(SuppressionEndReason::TrustLost);
    }

    /// A command is running; the next trusted PromptReady returns AtPrompt.
    pub fn mark_running(&self) {
        // Command lifecycle uses Running for the same atomic trust loss boundary.
        let _publication = self.publication.lock();
        *self.trusted_at_prompt.lock() = None;
        self.set_host_phase(SessionPhase::Running);
    }

    /// Observes terminal bytes for DECSET 2004 without stripping them.
    pub fn observe_output(&self, bytes: &[u8]) {
        self.bracketed_paste.observe(bytes);
    }

    /// Whether the shell has enabled bracketed paste on this PTY.
    pub fn bracketed_paste_enabled(&self) -> bool {
        self.bracketed_paste.enabled()
    }

    /// Registers completion providers for this session.
    pub fn set_completion_providers(&self, providers: Vec<CompletionProvider>) {
        *self.completion_providers.lock() = providers;
    }

    /// Returns the first registered completion provider, if any.
    pub(super) fn first_completion_provider(&self) -> Option<CompletionProvider> {
        self.completion_providers.lock().first().cloned()
    }

    /// Marks the gate as being at a trusted shell prompt.
    pub fn mark_trusted_prompt(&self, generation: u64, cwd: String) {
        let _publication = self.publication.lock();
        *self.trusted_at_prompt.lock() = Some(PromptSnapshot { generation, cwd });
        self.set_host_phase(SessionPhase::AtPrompt);
    }

    /// Returns whether the session is at a trusted shell prompt.
    pub fn trusted_at_prompt(&self) -> bool {
        self.trusted_at_prompt.lock().is_some()
    }

    /// Trusted prompt generation and cwd, under the prompt lock only.
    pub fn trusted_prompt_snapshot(&self) -> Option<(u64, String)> {
        self.trusted_at_prompt
            .lock()
            .as_ref()
            .map(|snapshot| (snapshot.generation, snapshot.cwd.clone()))
    }

    /// Snapshot and watermark share the lifecycle publication boundary.
    pub fn authentic_session(&self) -> AuthenticSession {
        let publication = self.publication.lock();
        let prompt = self.trusted_at_prompt.lock();
        let identity = self.session_identity.lock();
        let state = publication.get();
        AuthenticSession {
            identity: identity
                .registered
                .then(|| identity.issued.clone())
                .flatten(),
            prompt: prompt.as_ref().map(|p| (p.generation, p.cwd.clone())),
            exited: state.exited,
            sequence: state.sequence,
            phase: state.phase,
        }
    }

    /// Capture replay state and lifecycle watermark before the first socket await.
    /// Exit updates both snapshots while holding this same publication lock.
    pub(crate) fn attach_snapshot(
        &self,
        hub: &crate::trackers::terminal_events::TerminalEventHub,
        terminal_id: &str,
    ) -> (
        AuthenticSession,
        crate::trackers::terminal_events::TerminalStateSnapshot,
    ) {
        let _publication = self.publication.lock();
        (self.authentic_session(), hub.snapshot(terminal_id))
    }

    /// Stamp and publish synchronously under the caller's state mutation boundary.
    pub(super) fn publish_event(
        &self,
        hub: &crate::trackers::terminal_events::TerminalEventHub,
        mut event: crate::trackers::terminal_events::TerminalEvent,
    ) {
        let publication = self.publication.lock();
        let mut state = publication.get();
        state.sequence = state
            .sequence
            .checked_add(1)
            .expect("lifecycle sequence exhausted");
        publication.set(state);
        event.set_lifecycle_sequence(state.sequence);
        hub.emit(event);
    }

    /// Process exit and its stream event form one synchronous transaction.
    pub(crate) fn publish_exit(
        &self,
        hub: &crate::trackers::terminal_events::TerminalEventHub,
        exit: impl FnOnce() -> crate::trackers::terminal_events::TerminalEvent,
    ) {
        let _publication = self.publication.lock();
        self.publish_event(hub, exit());
    }

    /// Drops trust and cancels the matching completion after a restore failure.
    pub fn restore_failed(&self, request_id: &str) {
        self.mark_raw();
        self.cancel_completion(request_id);
        self.generator_ended(request_id);
    }

    /// Starts one restorable generator at a trusted prompt when writing is allowed.
    /// Retains its slot only after a successful write and flush.
    pub async fn request_completion(
        &self,
        request: &CompletionRequest,
        provider: &CompletionProvider,
        allow_write: bool,
    ) -> CompletionStart {
        self.request_completion_authorized(request, provider, allow_write, None)
            .await
            .unwrap_or_else(|_| CompletionStart::without_waiter(SessionRpcResult::NotStarted))
    }

    /// Same as [`Self::request_completion`], refusing the trigger write when
    /// `authorization` no longer matches. Generation is checked under the
    /// claims lock that rotate/revoke use to bump it.
    pub async fn request_completion_authorized(
        &self,
        request: &CompletionRequest,
        provider: &CompletionProvider,
        allow_write: bool,
        authorization: Option<&ClaimWriteLease<'_>>,
    ) -> Result<CompletionStart, ClaimError> {
        if !allow_write || !provider.restorable || !self.trusted_at_prompt() {
            return Ok(CompletionStart::without_waiter(
                SessionRpcResult::NotStarted,
            ));
        }
        let Some(trigger) = completion_trigger(request, provider) else {
            return Ok(CompletionStart::without_waiter(
                SessionRpcResult::NotStarted,
            ));
        };
        let request_id = request.request_id.as_str();
        self.notify_about_to_lock_writer();
        let mut guard = self.writer.lock().await;
        authorized_write(authorization, || {
            // Lock order: writer -> claims -> publication -> prompt -> completion; no await below.
            let _publication = self.publication.lock();
            // Keep trust locked through the write and state update so restore failure cannot overtake them.
            let mut trusted_at_prompt = self.trusted_at_prompt.lock();
            let mut completion = self.completion.lock();
            if !trusted_at_prompt
                .as_ref()
                .is_some_and(|prompt| prompt.matches(request))
                || completion.occupied()
            {
                return CompletionStart::without_waiter(SessionRpcResult::NotStarted);
            }
            self.suppression.start(request_id);
            let result = Self::write_and_flush(&mut guard, &[&trigger]);
            if result != SessionRpcResult::Accepted {
                self.end_suppression(SuppressionEndReason::TrustLost);
                if result == SessionRpcResult::Partial {
                    *trusted_at_prompt = None;
                    self.set_host_phase(SessionPhase::Raw);
                }
                return CompletionStart::without_waiter(result);
            }
            let (epoch, waiter) =
                completion.admit(request.clone(), self.session_identity.lock().issued.clone());
            CompletionStart {
                result: SessionRpcResult::Accepted,
                waiter: Some(waiter),
                epoch: Some(epoch),
            }
        })
    }

    /// Returns true while completion output suppression is active.
    pub fn suppressing_output(&self) -> bool {
        self.suppression.is_active()
    }

    /// Ends the completion output suppression window.
    pub fn end_suppression(&self, reason: SuppressionEndReason) {
        self.suppression.end(reason);
    }

    /// Clears the shell line and writes the draft once under the writer lock.
    pub async fn submit(&self, draft: &str, allow_write: bool) -> SessionRpcResult {
        self.submit_authorized(draft, allow_write, None)
            .await
            .unwrap_or(SessionRpcResult::NotStarted)
    }

    /// Same as [`Self::submit`], refusing the draft write when `authorization`
    /// no longer matches. After drain/paste waits, generation is checked under
    /// the claims lock that rotate/revoke use to bump it.
    pub async fn submit_authorized(
        &self,
        draft: &str,
        allow_write: bool,
        authorization: Option<&ClaimWriteLease<'_>>,
    ) -> Result<SessionRpcResult, ClaimError> {
        let result = async {
            if !allow_write {
                return Ok(SessionRpcResult::NotStarted);
            }
            self.notify_about_to_lock_writer();
            let mut guard = self.writer.lock().await;
            if authorization.is_some_and(|lease| !lease.is_current()) {
                return Err(ClaimError);
            }
            let cancelled_epoch = self.cancel_active_completion();
            if !self.drain_generators().await {
                {
                    let _publication = self.publication.lock();
                    let mut prompt = self.trusted_at_prompt.lock();
                    // The writer and publication guards precede prompt/completion locks.
                    *prompt = None;
                    self.set_host_phase(SessionPhase::Raw);
                    self.release_active_completion(cancelled_epoch);
                }
                drop(guard);
                self.notify_trust_loss(SuppressionEndReason::DrainTimeout);
                return Ok(SessionRpcResult::NotStarted);
            }
            self.wait_for_bracketed_paste().await;
            let result = authorized_write(authorization, || {
                self.write_submitted_draft(&mut guard, draft)
            })?;
            drop(guard);
            Ok(result)
        }
        .await;
        match result {
            Ok(result) => Ok(Self::log_write_result("submit", result)),
            Err(error) => {
                tracing::warn!("[session-gate] submit result=Unauthorized");
                Err(error)
            }
        }
    }

    async fn wait_for_bracketed_paste(&self) {
        self.bracketed_paste
            .wait_for_enabled(BRACKETED_PASTE_WAIT)
            .await;
    }

    fn write_submitted_draft(
        &self,
        guard: &mut Option<Box<dyn Write + Send>>,
        draft: &str,
    ) -> SessionRpcResult {
        // The caller holds writer; publication keeps trust and Running atomic.
        // Keep trust locked through the write so restore failure cannot complete before it.
        let _publication = self.publication.lock();
        let mut trusted_at_prompt = self.trusted_at_prompt.lock();
        if trusted_at_prompt.is_none() {
            return SessionRpcResult::NotStarted;
        }
        if draft_has_disallowed_controls(draft) {
            log::warn!("[session-gate] submit refused: draft contains disallowed controls");
            tracing::warn!("[session-gate] submit refused: draft contains disallowed controls");
            return SessionRpcResult::PreWrite;
        }
        // Without DECSET 2004 the host writes the draft as plain bytes; a multiline
        // draft then runs line by line (same limitation as Warp).
        let sequences = submit_byte_sequences(draft, self.bracketed_paste.enabled());
        let result = Self::write_and_flush(guard, &sequences);
        if matches!(
            result,
            SessionRpcResult::Accepted | SessionRpcResult::Partial
        ) {
            *trusted_at_prompt = None;
            self.set_host_phase(SessionPhase::Running);
        }
        result
    }

    async fn drain_generators(&self) -> bool {
        let drained = tokio::time::timeout(GENERATOR_DRAIN_TIMEOUT, async {
            loop {
                let notified = self.generator_finished.notified();
                if !self.completion.lock().occupied() {
                    break;
                }
                notified.await;
            }
        })
        .await;
        if drained.is_err() {
            return false;
        }
        true
    }

    /// Restores the shell prompt without a draft under the writer lock, without requiring trust.
    pub async fn restore_prompt(&self, allow_write: bool) -> SessionRpcResult {
        self.restore_prompt_authorized(allow_write, None)
            .await
            .unwrap_or(SessionRpcResult::NotStarted)
    }

    /// Same as [`Self::restore_prompt`], refusing the sequence write when
    /// `authorization` no longer matches. Generation is checked under the
    /// claims lock that rotate/revoke use to bump it.
    pub async fn restore_prompt_authorized(
        &self,
        allow_write: bool,
        authorization: Option<&ClaimWriteLease<'_>>,
    ) -> Result<SessionRpcResult, ClaimError> {
        if !allow_write {
            return Ok(Self::log_write_result(
                "restore_prompt",
                SessionRpcResult::NotStarted,
            ));
        }
        self.notify_about_to_lock_writer();
        let mut guard = self.writer.lock().await;
        let result = authorized_write(authorization, || {
            let publication = self.publication.lock();
            let mut state = publication.get();
            if state.restored_epoch == Some(state.restore_epoch) {
                return SessionRpcResult::Accepted;
            }
            let result = Self::write_and_flush(&mut guard, &[RESTORE_PROMPT_SEQUENCE.as_bytes()]);
            if matches!(
                result,
                SessionRpcResult::Accepted | SessionRpcResult::Partial
            ) {
                state.restored_epoch = Some(state.restore_epoch);
                publication.set(state);
            }
            result
        })?;
        Ok(Self::log_write_result("restore_prompt", result))
    }

    fn write_and_flush(
        writer: &mut Option<Box<dyn Write + Send>>,
        sequences: &[&[u8]],
    ) -> SessionRpcResult {
        let Some(writer) = writer.as_mut() else {
            return SessionRpcResult::PreWrite;
        };
        for sequence in sequences {
            if writer.write_all(sequence).is_err() {
                return SessionRpcResult::Partial;
            }
        }
        if writer.flush().is_err() {
            return SessionRpcResult::Partial;
        }
        SessionRpcResult::Accepted
    }

    fn log_write_result(operation: &str, result: SessionRpcResult) -> SessionRpcResult {
        if result != SessionRpcResult::Accepted {
            tracing::warn!("[session-gate] {operation} result={result:?}");
        }
        result
    }
}

fn authorized_write<T>(
    authorization: Option<&ClaimWriteLease<'_>>,
    op: impl FnOnce() -> T,
) -> Result<T, ClaimError> {
    match authorization {
        None => Ok(op()),
        Some(lease) => lease.if_current(op).ok_or(ClaimError),
    }
}

fn draft_has_disallowed_controls(draft: &str) -> bool {
    draft.chars().any(|ch| {
        let code = ch as u32;
        !matches!(code, 0x09 | 0x0A)
            && (code <= 0x1F || code == 0x7F || (0x80..=0x9F).contains(&code))
    })
}

fn submit_byte_sequences(draft: &str, paste_on: bool) -> Vec<&[u8]> {
    if draft.is_empty() {
        return vec![CLEAR_LINE_SEQUENCE.as_bytes(), b"\r"];
    }
    if paste_on {
        return vec![
            CLEAR_LINE_SEQUENCE.as_bytes(),
            b"\x1b[200~",
            draft.as_bytes(),
            b"\x1b[201~",
            b"\r",
        ];
    }
    vec![CLEAR_LINE_SEQUENCE.as_bytes(), draft.as_bytes(), b"\r"]
}

fn completion_trigger(
    request: &CompletionRequest,
    provider: &CompletionProvider,
) -> Option<Vec<u8>> {
    let mut units = 0;
    let mut prefix = String::new();
    for ch in request.draft.chars() {
        if units == request.cursor {
            break;
        }
        units += ch.len_utf16() as u64;
        if units > request.cursor {
            return None;
        }
        prefix.push(ch);
    }
    if units != request.cursor {
        return None;
    }
    let hex: String = prefix
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut trigger = Vec::new();
    if !provider.command.starts_with(b"\x1b0Di\x15") {
        trigger.extend_from_slice(b"\x1b0Di\x15");
    }
    trigger.extend_from_slice(&provider.command);
    if !trigger.ends_with(b" ") {
        trigger.push(b' ');
    }
    trigger.extend_from_slice(
        format!(
            "{} {} {} {}\r",
            request.request_id, request.buffer_revision, request.cursor, hex
        )
        .as_bytes(),
    );
    Some(trigger)
}
