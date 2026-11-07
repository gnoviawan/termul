//! The handshake between an awaiting task and a closure it queued on the UI
//! thread. The host answers a timed-out call as failed, so a closure that
//! reaches the front of a busy UI thread afterwards must not issue its
//! command: the agent may already have retried it.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const PENDING: u8 = 0;
const ISSUED: u8 = 1;
const CANCELLED: u8 = 2;

#[derive(Clone, Default)]
pub struct IssueGate(Arc<AtomicU8>);

impl IssueGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Called by the queued closure before it issues. False means the
    /// awaiting side gave up first and the closure must do nothing.
    pub fn claim(&self) -> bool {
        self.0
            .compare_exchange(PENDING, ISSUED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Called by the awaiting side on timeout. True means the closure had
    /// not issued and now never will.
    pub fn cancel(&self) -> bool {
        self.0
            .compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Cancels when dropped, so an awaiting future that is dropped (an outer
    /// deadline) stands the queued closure down too.
    pub fn cancel_on_drop(&self) -> CancelOnDrop {
        CancelOnDrop(self.clone())
    }
}

pub struct CancelOnDrop(IssueGate);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
#[path = "issue_gate_tests.rs"]
mod tests;
