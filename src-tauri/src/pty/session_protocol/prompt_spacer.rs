//! Host-side prompt spacing byte transformer.
//!
//! # Purpose
//! Injects blank rows around the private Termul prompt mark (`\x1b]133;A;termul\x07` or
//! `\x1b]133;A;termul\x1b\\`) when a completed visible line has been forwarded since the
//! previous mark.
//!
//! # Layout
//! ```text
//! last output row
//! <blank row>          <- injected "\r\n" BEFORE the mark
//! ──────── line ───────   (decoration at top of the mark row)
//! <blank mark row>     <- injected "\r\n" AFTER the mark
//! command echo / prompt
//! ```
//!
//! # Mark Matching
//! Matches only the exact private mark `\x1b]133;A;termul` terminated by BEL (`0x07`) or
//! ST (`\x1b\\`). Plain `133;A` from user prompts or redisplay is passed through untouched
//! and never spaced.
//!
//! # Content Detection
//! A completed visible line sets `content_since_mark`. In Ground state, any printable
//! non-whitespace byte (`0x21..=0x7e` or `>= 0x80`) marks the current line dirty. A LF
//! (`0x0a`) while dirty sets `content_since_mark` and clears the dirty flag. Carriage return
//! (`0x0d`) does not clear the dirty flag.
//!
//! # Screen Clears
//! A full screen clear (`CSI 2 J`, `CSI 3 J`, or `ESC c` RIS) resets both flags so the
//! subsequent prompt is not spaced at the top of the terminal. Partial clears (`CSI 1 J`
//! or `CSI J`) do not reset.
//!
//! # Empty Enter Guarantee Scope
//! An empty Enter keypress produces no blank rows when the shell prompt is suppressed
//! (Termul native-editor mode). In raw/fallback mode where the shell draws a visible prompt,
//! the prompt text followed by the Enter echo constitutes a completed visible line, so
//! the subsequent prompt will be spaced.
//!
//! # Escape Subset
//! Tracks Ground, Esc, EscInter, Csi, Osc, and Str (DCS/SOS/PM/APC). Non-Ground bytes never
//! count as content. Cancel (`0x18`) and substitute (`0x1a`) abort escape sequences back
//! to Ground. No full terminal emulation (C1 8-bit controls and charset selection are
//! excluded).

const TARGET_BEL: &[u8] = b"\x1b]133;A;termul\x07";
const TARGET_ST: &[u8] = b"\x1b]133;A;termul\x1b\\";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum EscapeState {
    #[default]
    Ground,
    Esc,
    EscInter,
    Csi,
    Osc,
    OscEsc,
    Str,
    StrEsc,
}

/// Transforms terminal bytes by injecting blank rows around prompt marks after output.
#[derive(Default)]
pub struct PromptSpacer {
    state: EscapeState,
    csi_params: [u8; 16],
    csi_params_len: usize,
    held: Vec<u8>,
    line_dirty: bool,
    content_since_mark: bool,
}

impl PromptSpacer {
    /// Creates a prompt spacer with default state.
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Transforms chunk bytes, injecting blank rows around prompt marks when content precedes.
    pub fn apply(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len() + 8);
        for &byte in input {
            self.feed_byte(byte, &mut output);
        }
        output
    }

    fn feed_byte(&mut self, byte: u8, output: &mut Vec<u8>) {
        if !self.held.is_empty() {
            let mut candidate = self.held.clone();
            candidate.push(byte);
            if candidate == TARGET_BEL || candidate == TARGET_ST {
                self.emit_matched_mark(&candidate, output);
                return;
            }
            if is_strict_mark_prefix(&candidate) {
                self.held.push(byte);
                return;
            }
            self.handle_divergence(byte, output);
            return;
        }

        if byte == 0x1b {
            self.held.push(0x1b);
            return;
        }

        self.process_machine_byte(byte, output);
    }

    fn handle_divergence(&mut self, diverging_byte: u8, output: &mut Vec<u8>) {
        let old_held = std::mem::take(&mut self.held);
        if old_held.len() == 15 {
            for &byte in &old_held[..14] {
                self.process_machine_byte(byte, output);
            }
            self.feed_byte(old_held[14], output);
            self.feed_byte(diverging_byte, output);
        } else {
            for &byte in &old_held {
                self.process_machine_byte(byte, output);
            }
            self.feed_byte(diverging_byte, output);
        }
    }

    fn emit_matched_mark(&mut self, mark: &[u8], output: &mut Vec<u8>) {
        if self.content_since_mark {
            output.extend_from_slice(b"\r\n");
            output.extend_from_slice(mark);
            output.extend_from_slice(b"\r\n");
        } else {
            output.extend_from_slice(mark);
        }
        self.state = EscapeState::Ground;
        self.csi_params_len = 0;
        self.content_since_mark = false;
        self.line_dirty = false;
        self.held.clear();
    }

    fn process_machine_byte(&mut self, byte: u8, output: &mut Vec<u8>) {
        output.push(byte);
        match self.state {
            EscapeState::Ground => self.step_ground(byte),
            EscapeState::Esc => self.step_esc(byte),
            EscapeState::EscInter => self.step_esc_inter(byte),
            EscapeState::Csi => self.step_csi(byte),
            EscapeState::Osc => self.step_osc(byte),
            EscapeState::OscEsc => self.step_osc_esc(byte),
            EscapeState::Str => self.step_str(byte),
            EscapeState::StrEsc => self.step_str_esc(byte),
        }
    }

    fn step_ground(&mut self, byte: u8) {
        match byte {
            0x1b => self.state = EscapeState::Esc,
            b'\n' => {
                if self.line_dirty {
                    self.content_since_mark = true;
                    self.line_dirty = false;
                }
            }
            b'\r' => {}
            0x21..=0x7e | 0x80..=0xff => self.line_dirty = true,
            _ => {}
        }
    }

    fn step_esc(&mut self, byte: u8) {
        match byte {
            b'[' => {
                self.state = EscapeState::Csi;
                self.csi_params_len = 0;
            }
            b']' => self.state = EscapeState::Osc,
            b'P' | b'X' | b'^' | b'_' => self.state = EscapeState::Str,
            0x20..=0x2f => self.state = EscapeState::EscInter,
            b'c' => {
                self.content_since_mark = false;
                self.line_dirty = false;
                self.state = EscapeState::Ground;
            }
            0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::Esc,
            _ => self.state = EscapeState::Ground,
        }
    }

    fn step_esc_inter(&mut self, byte: u8) {
        match byte {
            0x20..=0x2f => {}
            0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::Esc,
            _ => self.state = EscapeState::Ground,
        }
    }

    fn step_csi(&mut self, byte: u8) {
        match byte {
            0x18 | 0x1a => {
                self.state = EscapeState::Ground;
                self.csi_params_len = 0;
            }
            0x1b => {
                self.state = EscapeState::Esc;
                self.csi_params_len = 0;
            }
            0x40..=0x7e => {
                if byte == b'J' {
                    let params = &self.csi_params[..self.csi_params_len];
                    if params == b"2" || params == b"3" {
                        self.content_since_mark = false;
                        self.line_dirty = false;
                    }
                }
                self.state = EscapeState::Ground;
                self.csi_params_len = 0;
            }
            _ => {
                if self.csi_params_len < self.csi_params.len() {
                    self.csi_params[self.csi_params_len] = byte;
                    self.csi_params_len += 1;
                }
            }
        }
    }

    fn step_osc(&mut self, byte: u8) {
        match byte {
            0x07 | 0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::OscEsc,
            _ => {}
        }
    }

    fn step_osc_esc(&mut self, byte: u8) {
        match byte {
            b'\\' => self.state = EscapeState::Ground,
            0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::OscEsc,
            _ => {
                self.state = EscapeState::Esc;
                self.step_esc(byte);
            }
        }
    }

    fn step_str(&mut self, byte: u8) {
        match byte {
            0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::StrEsc,
            _ => {}
        }
    }

    fn step_str_esc(&mut self, byte: u8) {
        match byte {
            b'\\' => self.state = EscapeState::Ground,
            0x18 | 0x1a => self.state = EscapeState::Ground,
            0x1b => self.state = EscapeState::StrEsc,
            _ => {
                self.state = EscapeState::Esc;
                self.step_esc(byte);
            }
        }
    }

    #[cfg(test)]
    pub fn content_since_mark(&self) -> bool {
        self.content_since_mark
    }

    #[cfg(test)]
    pub fn line_dirty(&self) -> bool {
        self.line_dirty
    }
}

fn is_strict_mark_prefix(candidate: &[u8]) -> bool {
    (TARGET_BEL.starts_with(candidate) && candidate.len() < TARGET_BEL.len())
        || (TARGET_ST.starts_with(candidate) && candidate.len() < TARGET_ST.len())
}
