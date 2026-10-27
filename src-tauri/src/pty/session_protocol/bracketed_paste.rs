//! Tracks DECSET 2004 (bracketed paste) from shell output without stripping it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;

#[derive(Clone, Copy, Default)]
enum ParserState {
    #[default]
    Ground,
    Esc,
    Csi,
    Params,
}

#[derive(Default)]
struct Parser {
    state: ParserState,
    current: u32,
    saw_2004: bool,
}

/// Observes CSI `?2004h` / `?2004l` across chunk boundaries.
#[derive(Default)]
pub struct BracketedPasteTracker {
    enabled: AtomicBool,
    ever_enabled: AtomicBool,
    notify: Notify,
    parser: Mutex<Parser>,
}

impl BracketedPasteTracker {
    pub fn observe(&self, bytes: &[u8]) {
        let mut parser = self.parser.lock();
        let mut off_to_on = false;
        for &byte in bytes {
            if let Some(enabled) = parser.push(byte) {
                if enabled {
                    self.ever_enabled.store(true, Ordering::Release);
                }
                let prev = self.enabled.swap(enabled, Ordering::AcqRel);
                if !prev && enabled {
                    off_to_on = true;
                }
            }
        }
        drop(parser);
        if off_to_on {
            self.notify.notify_waiters();
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn ever_enabled(&self) -> bool {
        self.ever_enabled.load(Ordering::Acquire)
    }

    pub fn notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.notify.notified()
    }

    pub async fn wait_for_enabled(&self, timeout: Duration) -> bool {
        if !self.ever_enabled() || self.enabled() {
            return self.enabled();
        }
        let notified = self.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.enabled() {
            return true;
        }
        if tokio::time::timeout(timeout, notified).await.is_err() {
            tracing::debug!("[session-gate] DECSET 2004 wait timed out; submitting plain bytes");
        }
        self.enabled()
    }
}

impl Parser {
    fn push(&mut self, byte: u8) -> Option<bool> {
        match self.state {
            ParserState::Ground => {
                if byte == 0x1b {
                    self.state = ParserState::Esc;
                }
                None
            }
            ParserState::Esc => {
                self.state = if byte == b'[' {
                    ParserState::Csi
                } else {
                    ParserState::Ground
                };
                None
            }
            ParserState::Csi => {
                if byte == b'?' {
                    self.current = 0;
                    self.saw_2004 = false;
                    self.state = ParserState::Params;
                    None
                } else {
                    self.reset();
                    None
                }
            }
            ParserState::Params => self.push_param(byte),
        }
    }

    fn push_param(&mut self, byte: u8) -> Option<bool> {
        match byte {
            b'0'..=b'9' => {
                self.current = self
                    .current
                    .saturating_mul(10)
                    .saturating_add((byte - b'0') as u32);
                None
            }
            b';' => {
                self.saw_2004 |= self.current == 2004;
                self.current = 0;
                None
            }
            b'h' | b'l' => {
                let matched = self.saw_2004 || self.current == 2004;
                self.reset();
                matched.then_some(byte == b'h')
            }
            _ => {
                self.reset();
                None
            }
        }
    }

    fn reset(&mut self) {
        self.state = ParserState::Ground;
        self.current = 0;
        self.saw_2004 = false;
    }
}
