//! Prompt snapshots and exactly-once completion decisions.

use super::frame::CompletionResult;
use super::gate::{CompletionRequest, SessionGate, SessionPhase, GENERATOR_DRAIN_TIMEOUT};
use super::rpc::{CompletionOutcome, COMPLETION_TIMEOUT};
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(Clone)]
pub(super) struct PromptSnapshot {
    pub generation: u64,
    pub cwd: String,
}

impl PromptSnapshot {
    pub fn matches(&self, request: &CompletionRequest) -> bool {
        self.generation == request.prompt_generation && self.cwd == request.cwd
    }
}

pub(super) type CompletionDelivery = Result<CompletionResult, CompletionOutcome>;

struct ActiveCompletion {
    request: CompletionRequest,
    identity: Option<(String, String)>,
    sender: Option<oneshot::Sender<CompletionDelivery>>,
    decision: Option<CompletionOutcome>,
    occupied: bool,
}

impl ActiveCompletion {
    fn owns_frame(&self, frame: &CompletionResult) -> bool {
        self.request.request_id == frame.request_id
            && self.identity.as_ref().is_some_and(|(session, nonce)| {
                session == &frame.session_id && nonce == &frame.nonce
            })
    }

    fn matches_context(&self, frame: &CompletionResult) -> bool {
        self.request.prompt_generation == frame.prompt_generation
            && self.request.cwd == frame.cwd
            && self.request.buffer_revision == frame.buffer_revision
            && self.request.cursor == frame.cursor
    }

    fn decide(&mut self, outcome: CompletionOutcome) -> bool {
        if self.decision.is_some() {
            return false;
        }
        self.decision = Some(outcome);
        log::debug!("[session-gate] completion terminal decision={outcome:?}");
        tracing::debug!("[session-gate] completion terminal decision={outcome:?}");
        true
    }

    fn deliver(&mut self, frame: Option<CompletionResult>) {
        let Some(sender) = self.sender.take() else {
            return;
        };
        let outcome = self.decision.expect("terminal decision precedes delivery");
        let delivery = match (outcome, frame) {
            (CompletionOutcome::Completed, Some(frame)) => Ok(frame),
            _ => Err(outcome),
        };
        let _ = sender.send(delivery);
    }
}

#[derive(Default)]
pub(super) struct CompletionState {
    epoch: u64,
    active: Option<ActiveCompletion>,
}

impl CompletionState {
    pub fn occupied(&self) -> bool {
        self.active.as_ref().is_some_and(|active| active.occupied)
    }

    pub fn admit(
        &mut self,
        request: CompletionRequest,
        identity: Option<(String, String)>,
    ) -> (u64, oneshot::Receiver<CompletionDelivery>) {
        self.epoch += 1;
        let (sender, waiter) = oneshot::channel();
        self.active = Some(ActiveCompletion {
            request,
            identity,
            sender: Some(sender),
            decision: None,
            occupied: true,
        });
        (self.epoch, waiter)
    }

    fn matching_epoch(&mut self, epoch: u64) -> Option<&mut ActiveCompletion> {
        if self.epoch != epoch {
            return None;
        }
        self.active.as_mut().filter(|active| active.occupied)
    }
}

impl SessionGate {
    /// Whether a request is still waiting for a terminal decision.
    pub fn generator_active(&self) -> bool {
        self.completion
            .lock()
            .active
            .as_ref()
            .is_some_and(|active| active.decision.is_none())
    }

    /// Authenticated frames drain occupancy even after cancel or timeout won.
    pub fn finish_completion(&self, frame: CompletionResult) {
        let lost_trust = {
            let _publication = self.publication.lock();
            let mut prompt = self.trusted_at_prompt.lock();
            let mut state = self.completion.lock();
            let Some(active) = state
                .active
                .as_mut()
                .filter(|active| active.owns_frame(&frame))
            else {
                return;
            };
            let lost_trust = !active.matches_context(&frame);
            let outcome = if lost_trust {
                *prompt = None;
                self.set_host_phase(SessionPhase::Raw);
                CompletionOutcome::Dropped
            } else {
                CompletionOutcome::Completed
            };
            active.decide(outcome);
            active.occupied = false;
            self.suppression.end_for_frame(&frame.request_id);
            active.deliver(Some(frame));
            state.active = None;
            self.generator_finished.notify_one();
            lost_trust
        };
        if lost_trust {
            self.notify_trust_loss(super::suppression::SuppressionEndReason::TrustLost);
        }
    }

    /// Ends trust, suppression, occupancy, and waiters when the PTY process exits.
    pub fn process_exited(&self) {
        let publication = self.publication.lock();
        let mut state = publication.get();
        state.exited = true;
        // Process exit invalidates prompt trust in this same publication boundary.
        publication.set(state);
        let mut prompt = self.trusted_at_prompt.lock();
        let mut state = self.completion.lock();
        *prompt = None;
        self.set_host_phase(SessionPhase::Raw);
        if let Some(active) = state.active.as_mut() {
            let _ = active.decide(CompletionOutcome::TimedOut);
            active.occupied = false;
            active.deliver(None);
        }
        state.active = None;
        self.generator_finished.notify_one();
        self.end_suppression(super::suppression::SuppressionEndReason::ProcessExit);
        log::debug!("[session-gate] process exited; completion waiters released");
        tracing::debug!("[session-gate] process exited; completion waiters released");
    }

    /// Cancel decides the reply immediately while retaining shell occupancy and suppression.
    pub fn cancel_completion(&self, request_id: &str) -> bool {
        let mut state = self.completion.lock();
        let Some(active) = state
            .active
            .as_mut()
            .filter(|active| active.request.request_id == request_id)
        else {
            return false;
        };
        if !active.decide(CompletionOutcome::Cancelled) {
            return false;
        }
        active.deliver(None);
        true
    }

    pub(super) fn cancel_active_completion(&self) -> Option<u64> {
        let mut state = self.completion.lock();
        if let Some(active) = &mut state.active {
            if active.decide(CompletionOutcome::Cancelled) {
                active.deliver(None);
            }
        }
        state.active.as_ref().map(|_| state.epoch)
    }

    pub(super) fn generator_ended(&self, request_id: &str) {
        let mut state = self.completion.lock();
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.request.request_id == request_id)
        {
            state.active = None;
            self.generator_finished.notify_one();
        }
    }

    /// Frees occupancy so a later watchdog for this epoch is a no-op.
    /// Callers must not hold gate locks across `notify_trust_loss`.
    pub(super) fn release_active_completion(&self, epoch: Option<u64>) {
        let mut state = self.completion.lock();
        let Some(active) = epoch.and_then(|epoch| state.matching_epoch(epoch)) else {
            return;
        };
        let _ = active.decide(CompletionOutcome::Cancelled);
        active.occupied = false;
        self.suppression.end_for_frame(&active.request.request_id);
        active.deliver(None);
        state.active = None;
        self.generator_finished.notify_one();
    }

    /// Spawn a host deadline independently of the RPC waiter and any submit.
    pub(super) fn start_completion_watchdog(self: &Arc<Self>, epoch: u64) {
        let gate = Arc::downgrade(self);
        let deadline = tokio::time::Instant::now() + COMPLETION_TIMEOUT;
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let draining = gate
                .upgrade()
                .is_some_and(|gate| gate.timeout_completion(epoch));
            if !draining {
                return;
            }
            tokio::time::sleep(GENERATOR_DRAIN_TIMEOUT).await;
            if let Some(gate) = gate.upgrade() {
                gate.completion_watchdog(epoch);
            }
        });
    }

    fn timeout_completion(&self, epoch: u64) -> bool {
        let mut state = self.completion.lock();
        let Some(active) = state.matching_epoch(epoch) else {
            return false;
        };
        active.decide(CompletionOutcome::TimedOut);
        true
    }

    fn completion_watchdog(&self, epoch: u64) {
        {
            let _publication = self.publication.lock();
            let mut prompt = self.trusted_at_prompt.lock();
            let mut state = self.completion.lock();
            let Some(active) = state.matching_epoch(epoch) else {
                return;
            };
            *prompt = None;
            self.set_host_phase(SessionPhase::Raw);
            self.end_suppression(super::suppression::SuppressionEndReason::Watchdog);
            active.occupied = false;
            active.deliver(None);
            state.active = None;
            self.generator_finished.notify_one();
            log::warn!("[session-gate] Completion drain watchdog expired; prompt trust ended");
            tracing::warn!("[session-gate] Completion drain watchdog expired; prompt trust ended");
        }
        self.notify_trust_loss(super::suppression::SuppressionEndReason::Watchdog);
    }
}
