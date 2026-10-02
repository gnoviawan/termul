/// ADR-002.5: DA (Device Attribute) Filter
///
/// Intercepts DA queries in the PTY byte stream and responds directly
/// to the PTY writer, preventing shell startup hangs when xterm.js
/// hasn't initialized or is busy replaying scrollback.
///
/// ## DA Query Types
///
/// | Type   | Sequence   | Response         |
/// |--------|-----------|------------------|
/// | DA1    | `\x1b[c`  | `\x1b[?1;2c`     |
/// | DA2    | `\x1b[>c` | `\x1b[>0;276;0c` |
/// | DA3    | `\x1b[=c` | (silent drop)    |
///
/// ## State Machine
///
/// ```text
/// Idle ──ESC(0x1b)──→ AfterEsc ──'['(0x5b)──→ InsideCsi ──final(0x40-0x7e)──→ check+respond
///   │                    │                                                      │
///   └─ other byte ──→    └─ other byte ──→ flush hold                            └─→ Idle
/// ```
// DA1 response: "I am an xterm-256color terminal with VT220 features"
const DA1_RESPONSE: &[u8] = b"\x1b[?1;2c";

// DA2 response: "I am terminal version 0;276;0"
const DA2_RESPONSE: &[u8] = b"\x1b[>0;276;0c";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Waiting for ESC byte to begin a potential CSI sequence
    Idle,
    /// Received ESC, waiting for `[` to enter CSI or a final byte for a 2-byte seq
    AfterEsc,
    /// Inside a CSI sequence (`\x1b[...`), accumulating until final byte
    InsideCsi,
}

/// State machine that detects and responds to Device Attribute queries.
///
/// Passes all non-DA bytes through unchanged. For DA queries, writes an
/// immediate response to the PTY writer via the `respond` callback while
/// also passing the query bytes through to the frontend.
pub struct DaFilter {
    state: State,
    /// Buffer for partial CSI sequences split across read chunks.
    /// Cleared after each complete sequence or transition back to Idle.
    hold: Vec<u8>,
}

impl DaFilter {
    /// Create a new DA filter in the Idle state.
    pub fn new() -> Self {
        Self {
            state: State::Idle,
            hold: Vec::with_capacity(16),
        }
    }

    /// Process input bytes through the DA filter.
    ///
    /// - `input`: Raw bytes from the PTY reader.
    /// - `out`: Receives bytes that should be forwarded to the frontend.
    /// - `respond`: Closure called with DA response bytes to write back to PTY.
    ///   Only called for DA1 and DA2 queries (not DA3 or non-DA sequences).
    ///
    /// The state machine tracks partial CSI sequences across chunks internally
    /// via the `hold` buffer and `state` field — no separate hold-completion
    /// logic is needed at this level.
    pub fn process<F: FnMut(&[u8])>(&mut self, input: &[u8], out: &mut Vec<u8>, mut respond: F) {
        for &b in input {
            self.process_byte(b, out, &mut respond);
        }
    }

    /// Process a single byte through the state machine.
    fn process_byte<F: FnMut(&[u8])>(&mut self, b: u8, out: &mut Vec<u8>, respond: &mut F) {
        match self.state {
            State::Idle => {
                if b == 0x1b {
                    // Potential start of a CSI sequence
                    self.state = State::AfterEsc;
                    self.hold.clear();
                    self.hold.push(b);
                } else {
                    // Regular byte, pass through
                    out.push(b);
                }
            }

            State::AfterEsc => {
                self.hold.push(b);

                if b == 0x5b {
                    // ESC + [ → entering CSI
                    self.state = State::InsideCsi;
                } else if (0x40..=0x7e).contains(&b) {
                    // Two-byte complete sequence (e.g., ESC + letter)
                    // Not a CSI, pass through and return to Idle
                    out.extend_from_slice(&self.hold);
                    self.state = State::Idle;
                    self.hold.clear();
                } else if b == 0x1b {
                    // Double ESC — first was spurious, this one starts new sequence
                    out.push(0x1b); // Pass through the first ESC
                    self.hold.clear();
                    self.hold.push(b);
                    // Stay in AfterEsc
                } else {
                    // Unexpected byte after ESC — not a CSI sequence
                    out.extend_from_slice(&self.hold);
                    self.state = State::Idle;
                    self.hold.clear();
                }
            }

            State::InsideCsi => {
                self.hold.push(b);

                if (0x40..=0x7e).contains(&b) {
                    // Complete CSI sequence (final byte reached)
                    self.check_and_respond(&self.hold, out, respond);
                    self.state = State::Idle;
                    self.hold.clear();
                } else if b == 0x1b {
                    // Nested ESC inside CSI — the previous sequence was incomplete.
                    // Pass through everything before this ESC (except the ESC itself
                    // which starts a new potential sequence).
                    for &hb in &self.hold[..self.hold.len() - 1] {
                        out.push(hb);
                    }
                    self.hold.clear();
                    self.hold.push(b);
                    self.state = State::AfterEsc;
                }
                // Otherwise (parameter bytes, intermediate bytes), keep accumulating
            }
        }
    }

    /// Check if a complete CSI sequence is a DA query and respond accordingly.
    ///
    /// Sequence format: `ESC [ (<prefix>)? (<params>)* c`
    ///
    /// - `\x1b[c` → DA1 (no prefix): respond with terminal identity
    /// - `\x1b[>c` → DA2 (> prefix): respond with detailed identity
    /// - `\x1b[=c` → DA3 (= prefix): silently handled (no response)
    /// - `\x1b[?c` → DA response from terminal: pass through (not a query)
    /// - Other final bytes → regular CSI: pass through
    fn check_and_respond<F: FnMut(&[u8])>(&self, seq: &[u8], out: &mut Vec<u8>, respond: &mut F) {
        // seq[0] = ESC (0x1b), seq[1] = '[' (0x5b), seq[2..] = params + final byte
        let is_da_query = seq.last() == Some(&b'c');

        if is_da_query && seq.len() >= 3 {
            // The byte at index 2 is either a prefix character or the start of params
            let third = seq[2];

            match third {
                b'>' => {
                    // DA2: \x1b[>c — respond and pass through
                    respond(DA2_RESPONSE);
                }
                b'=' => {
                    // DA3: \x1b[=c — no response, but pass through to frontend
                    // (spec: "Silent drop (no response), pass through")
                }
                b'?' => {
                    // \x1b[?c — this is a terminal's response, not a query.
                    // Pass through unchanged — xterm.js handles it.
                    // Do NOT respond, to avoid infinite loops.
                }
                _ => {
                    // DA1: \x1b[c — respond and pass through
                    // DA1 without prefix or params: \x1b[c (3 bytes)
                    // With params: \x1b[1;2c etc.
                    // Either way, this is a DA1 query if byte before final 'c' is not ?/>/=
                    respond(DA1_RESPONSE);
                }
            }
        }

        // All sequences pass through to the frontend
        out.extend_from_slice(seq);
    }
}

#[cfg(test)]
mod tests;
