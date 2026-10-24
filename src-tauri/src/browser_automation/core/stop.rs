//! The session-scoped Stop latch.
//!
//! Every browser call takes a [`StopToken`] when it is admitted. Stop
//! latches the session and advances its epoch under one lock: every
//! outstanding token observes the change at its next await point and the
//! call ends with `confirmation_required` / `stopped_by_user`. A state
//! change a call wants to keep (an origin grant after an Allow) goes
//! through [`StopLatch::commit`], which runs it under the same lock only
//! while the token's epoch is current, so Stop always wins the race.

use std::collections::HashMap;
use std::future::Future;

use parking_lot::Mutex;
use tokio::sync::watch;

use super::{BrowserError, ERR_CONFIRMATION};

pub const REASON_STOPPED: &str = "stopped_by_user";

pub fn stopped_error() -> BrowserError {
    BrowserError::new(
        ERR_CONFIRMATION,
        "the user stopped browser automation for this session; it resumes after their next message",
    )
    .with_reason(REASON_STOPPED)
}

struct Latch {
    stopped: bool,
    epoch: watch::Sender<u64>,
}

impl Latch {
    fn new() -> Self {
        Self {
            stopped: false,
            epoch: watch::Sender::new(0),
        }
    }
}

#[derive(Default)]
pub struct StopLatch {
    sessions: Mutex<HashMap<String, Latch>>,
}

pub struct StopToken {
    epoch: u64,
    rx: watch::Receiver<u64>,
}

impl StopToken {
    pub fn is_stopped(&self) -> bool {
        // A dropped sender means the session was forgotten (ended).
        match self.rx.has_changed() {
            Err(_) => true,
            Ok(_) => *self.rx.borrow() != self.epoch,
        }
    }

    pub fn check(&self) -> Result<(), BrowserError> {
        if self.is_stopped() {
            Err(stopped_error())
        } else {
            Ok(())
        }
    }

    /// Run `work` until it finishes or the session is stopped, whichever
    /// comes first. Dropping `work` cancels it at its current await point.
    pub async fn guard<T>(
        &self,
        work: impl Future<Output = Result<T, BrowserError>>,
    ) -> Result<T, BrowserError> {
        let mut rx = self.rx.clone();
        let epoch = self.epoch;
        tokio::select! {
            biased;
            _ = rx.wait_for(|current| *current != epoch) => Err(stopped_error()),
            result = work => result,
        }
    }
}

impl StopLatch {
    /// Admit one call: `stopped_by_user` while the session is latched.
    pub fn begin(&self, session_id: &str) -> Result<StopToken, BrowserError> {
        let mut sessions = self.sessions.lock();
        let latch = sessions
            .entry(session_id.to_string())
            .or_insert_with(Latch::new);
        if latch.stopped {
            return Err(stopped_error());
        }
        let epoch = *latch.epoch.borrow();
        Ok(StopToken {
            epoch,
            rx: latch.epoch.subscribe(),
        })
    }

    /// Latch the session and wake every outstanding token. `revoke` runs
    /// under the latch lock, so no [`commit`](Self::commit) can land
    /// between the latch and the revocation. Returns false when the
    /// session was already stopped.
    pub fn stop(&self, session_id: &str, revoke: impl FnOnce()) -> bool {
        let mut sessions = self.sessions.lock();
        let latch = sessions
            .entry(session_id.to_string())
            .or_insert_with(Latch::new);
        let first = !latch.stopped;
        latch.stopped = true;
        latch.epoch.send_modify(|epoch| *epoch += 1);
        revoke();
        first
    }

    /// Clear the latch (the user's next prompt turn). Returns whether the
    /// session was stopped.
    pub fn resume(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .get_mut(session_id)
            .is_some_and(|latch| std::mem::replace(&mut latch.stopped, false))
    }

    pub fn is_stopped(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .get(session_id)
            .is_some_and(|l| l.stopped)
    }

    /// Run `keep` only if `token` is still current.
    pub fn commit<T>(
        &self,
        session_id: &str,
        token: &StopToken,
        keep: impl FnOnce() -> T,
    ) -> Result<T, BrowserError> {
        let sessions = self.sessions.lock();
        match sessions.get(session_id) {
            Some(latch) if !latch.stopped && *latch.epoch.borrow() == token.epoch => Ok(keep()),
            _ => Err(stopped_error()),
        }
    }

    /// Session ended: drop its latch, which also cancels its tokens.
    pub fn forget(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }
}

#[cfg(test)]
#[path = "stop_tests.rs"]
mod tests;
