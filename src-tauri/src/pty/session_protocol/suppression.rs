//! Completion output suppression window state for `SessionGate`.

use parking_lot::Mutex;

/// Reason the completion byte-suppression window ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressionEndReason {
    /// Ended because the authenticated prompt context was lost.
    TrustLost,
    /// Submit already revoked trust and released its epoch under the writer lock.
    DrainTimeout,
    /// Ended because the matching Completion frame arrived.
    Frame,
    /// Ended because the drain watchdog fired after timeout.
    Watchdog,
    /// Ended because the PTY process exited.
    ProcessExit,
}

/// Tracks the active completion request whose in-band generator output is suppressed.
#[derive(Default)]
pub struct SuppressionWindow {
    active_request: Mutex<Option<String>>,
}

impl SuppressionWindow {
    /// Creates an inactive suppression window.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts suppressing client output for `request_id` when the trigger is written.
    pub fn start(&self, request_id: &str) {
        *self.active_request.lock() = Some(request_id.to_owned());
    }

    /// Returns whether client output is currently suppressed.
    pub fn is_active(&self) -> bool {
        self.active_request.lock().is_some()
    }

    /// Ends suppression when `request_id` matches the active completion request.
    pub fn end_for_frame(&self, request_id: &str) -> bool {
        let mut guard = self.active_request.lock();
        if guard.as_deref() == Some(request_id) {
            *guard = None;
            true
        } else {
            false
        }
    }

    /// Ends suppression unconditionally when the frame or drain watchdog fires.
    pub fn end(&self, _reason: SuppressionEndReason) {
        *self.active_request.lock() = None;
    }
}
