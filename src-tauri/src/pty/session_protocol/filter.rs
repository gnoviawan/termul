//! Host byte filter for Termul session frames across output chunks.

use super::frame::{self, Frame};
use super::prompt_spacer::PromptSpacer;
use super::TERMUL_SESSION_OSC;

/// Maximum bytes held for one session frame.
pub const MAX_SESSION_FRAME_BYTES: usize = 64 * 1024;

/// Strips session OSC sequences, holding incomplete candidates and forwarding other bytes.
#[derive(Default)]
pub struct SessionFilter {
    held: Vec<u8>,
    discarding: bool,
    registered_nonce: Option<String>,
    spacer: PromptSpacer,
}

/// Output bytes with session OSC sequences removed and parsed session frames.
#[derive(Debug, PartialEq)]
pub enum FilterResult {
    /// Bytes to forward and successfully parsed session frames.
    Forwarded { bytes: Vec<u8>, frames: Vec<Frame> },
    /// Ordinary bytes to forward after an oversized session frame ends.
    Desync { bytes: Vec<u8> },
}

impl SessionFilter {
    /// Creates a session frame filter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses the gate's registered nonce to authenticate subsequent frames.
    pub fn set_registered_nonce(&mut self, nonce: Option<String>) {
        self.registered_nonce = nonce;
    }

    /// Injects spacing around prompt marks when content has been forwarded.
    pub fn space_prompts(&mut self, input: &[u8]) -> Vec<u8> {
        self.spacer.apply(input)
    }

    /// Strips completed or aborted session OSC sequences and returns parsed frames.
    pub fn process(&mut self, input: &[u8]) -> FilterResult {
        let mut buffered = std::mem::take(&mut self.held);
        buffered.extend_from_slice(input);
        self.process_buffer(&buffered)
    }

    fn process_buffer(&mut self, input: &[u8]) -> FilterResult {
        let mut bytes = Vec::with_capacity(input.len());
        let mut frames = Vec::new();
        let mut cursor = 0;
        let mut desync = false;
        while cursor < input.len() {
            if self.discarding {
                let Some(next_cursor) = self.resume_discard(input, cursor) else {
                    return output_result(bytes, vec![], desync);
                };
                desync = true;
                frames.clear();
                cursor = next_cursor;
                continue;
            }
            let Some(offset) = input[cursor..].windows(2).position(|w| w == b"\x1b]") else {
                break;
            };
            let start = cursor + offset;
            match classify_ident(&input[start + 2..]) {
                Some(false) => {
                    bytes.extend_from_slice(&input[cursor..start + 2]);
                    cursor = start + 2;
                    continue;
                }
                None => {
                    bytes.extend_from_slice(&input[cursor..start]);
                    self.hold_session(&input[start..], &mut frames);
                    return output_result(bytes, frames, desync);
                }
                Some(true) => {}
            }
            bytes.extend_from_slice(&input[cursor..start]);
            let Some(next_cursor) = self.complete_session(input, start, &mut frames, &mut desync)
            else {
                return output_result(bytes, frames, desync);
            };
            cursor = next_cursor;
        }
        self.forward_tail(&input[cursor..], &mut bytes);
        output_result(bytes, frames, desync)
    }

    fn resume_discard(&mut self, input: &[u8], cursor: usize) -> Option<usize> {
        let Some((_, next_cursor, _)) = find_frame_end(input, cursor) else {
            self.hold_escape(input);
            return None;
        };
        self.discarding = false;
        Some(next_cursor)
    }

    fn complete_session(
        &mut self,
        input: &[u8],
        start: usize,
        frames: &mut Vec<Frame>,
        desync: &mut bool,
    ) -> Option<usize> {
        let Some((payload_end, next_cursor, terminated)) = find_frame_end(input, start + 2) else {
            self.hold_session(&input[start..], frames);
            return None;
        };
        if next_cursor - start > MAX_SESSION_FRAME_BYTES {
            *desync = true;
            frames.clear();
        } else if terminated && !*desync {
            if let Some(frame) = parse_session(
                &input[start + 2..payload_end],
                self.registered_nonce.as_deref(),
            ) {
                frames.push(frame);
            }
        }
        Some(next_cursor)
    }

    fn hold_session(&mut self, candidate: &[u8], frames: &mut Vec<Frame>) {
        if candidate.len() > MAX_SESSION_FRAME_BYTES {
            self.discarding = true;
            frames.clear();
            self.hold_escape(candidate);
        } else {
            self.held.extend_from_slice(candidate);
        }
    }

    fn hold_escape(&mut self, input: &[u8]) {
        if input.ends_with(b"\x1b") {
            self.held.push(0x1b);
        }
    }

    fn forward_tail(&mut self, remaining: &[u8], bytes: &mut Vec<u8>) {
        let held_len = usize::from(remaining.ends_with(b"\x1b"));
        let forward_end = remaining.len() - held_len;
        bytes.extend_from_slice(&remaining[..forward_end]);
        self.held.extend_from_slice(&remaining[forward_end..]);
    }
}

// None means the ident or its delimiter is incomplete; false means a foreign ident.
fn classify_ident(candidate: &[u8]) -> Option<bool> {
    let ident = TERMUL_SESSION_OSC.to_string();
    let ident = ident.as_bytes();
    let matched_len = candidate.len().min(ident.len());
    if candidate[..matched_len] != ident[..matched_len] {
        return Some(false);
    }
    // A further digit or ordinary byte belongs to a foreign OSC (e.g. 94770/9477a).
    candidate
        .get(ident.len())
        .map(|byte| matches!(byte, b';' | 0x07 | 0x18 | 0x1a | 0x1b))
}

fn parse_session(payload: &[u8], registered_nonce: Option<&str>) -> Option<Frame> {
    let prefix = format!("{TERMUL_SESSION_OSC};");
    let payload = payload.strip_prefix(prefix.as_bytes())?;
    let value = serde_json::from_slice(payload).ok()?;
    frame::parse(&value, registered_nonce).ok()
}

// Returns the payload end, the next input position, and whether the frame terminated.
fn find_frame_end(input: &[u8], start: usize) -> Option<(usize, usize, bool)> {
    (start..input.len()).find_map(|index| match input[index] {
        0x07 => Some((index, index + 1, true)),
        0x18 | 0x1a => Some((index, index + 1, false)),
        0x1b if input[index..].starts_with(b"\x1b\\") => Some((index, index + 2, true)),
        // A trailing ESC may be half of ST; wait for the next chunk.
        0x1b if index + 1 < input.len() => Some((index, index, false)),
        _ => None,
    })
}

fn output_result(bytes: Vec<u8>, frames: Vec<Frame>, desync: bool) -> FilterResult {
    if desync {
        FilterResult::Desync { bytes }
    } else {
        FilterResult::Forwarded { bytes, frames }
    }
}
