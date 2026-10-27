use std::sync::{Arc, Mutex};

use super::deliver::process_reader_chunk;
use super::filter::SessionFilter;
use super::frame::SessionRpcResult;
use super::gate::SessionGate;
use super::gate_test_support::{capture_gate, start_completion};
use super::prompt_spacer::PromptSpacer;
use crate::trackers::terminal_events::TerminalEventHub;

const MARK_BEL: &[u8] = b"\x1b]133;A;termul\x07";
const MARK_ST: &[u8] = b"\x1b]133;A;termul\x1b\\";

#[test]
fn output_then_mark_is_spaced() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"out\r\n\x1b]133;A;termul\x07");
    assert_eq!(out, b"out\r\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn mark_with_no_prior_content_is_unchanged() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(MARK_BEL);
    assert_eq!(out, MARK_BEL);
}

#[test]
fn st_terminator_variant_is_spaced() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"out\r\n\x1b]133;A;termul\x1b\\");
    assert_eq!(out, b"out\r\n\r\n\x1b]133;A;termul\x1b\\\r\n");
}

#[test]
fn two_marks_in_one_chunk() {
    let mut spacer = PromptSpacer::new();
    // First mark spaced, second mark after output also spaced
    let out = spacer.apply(b"out\r\n\x1b]133;A;termul\x07prompt\r\n\x1b]133;A;termul\x07");
    assert_eq!(
        out,
        b"out\r\n\r\n\x1b]133;A;termul\x07\r\nprompt\r\n\r\n\x1b]133;A;termul\x07\r\n"
    );

    // Two marks in a row with no intervening content: only first is spaced
    let mut spacer2 = PromptSpacer::new();
    let out2 = spacer2.apply(b"out\r\n\x1b]133;A;termul\x07\x1b]133;A;termul\x07");
    assert_eq!(
        out2,
        b"out\r\n\r\n\x1b]133;A;termul\x07\r\n\x1b]133;A;termul\x07"
    );
}

#[test]
fn foreign_osc_sequences_are_untouched() {
    let mut spacer = PromptSpacer::new();
    // Plain 133;A is untouched and never spaced
    let out = spacer.apply(b"out\r\n\x1b]133;A\x07\x1b]133;B\x07\x1b]7;file:///test\x07");
    assert_eq!(
        out,
        b"out\r\n\x1b]133;A\x07\x1b]133;B\x07\x1b]7;file:///test\x07"
    );
}

#[test]
fn utf8_output_counts_as_content() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply("こんにちは\n\x1b]133;A;termul\x07".as_bytes());
    assert_eq!(out, "こんにちは\n\r\n\x1b]133;A;termul\x07\r\n".as_bytes());
}

#[test]
fn whitespace_only_enter_has_no_spacing() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"\r\n\r\n   \r\n\x1b]133;A;termul\x07");
    assert_eq!(out, b"\r\n\r\n   \r\n\x1b]133;A;termul\x07");
}

#[test]
fn mark_split_at_every_byte_offset() {
    for split in 1..MARK_BEL.len() {
        let mut spacer = PromptSpacer::new();
        let chunk1 = spacer.apply(&MARK_BEL[..split]);
        let chunk2 = spacer.apply(&MARK_BEL[split..]);
        let mut combined = chunk1;
        combined.extend_from_slice(&chunk2);
        assert_eq!(
            combined, MARK_BEL,
            "split at {split} diverged from expected unsplit output"
        );
    }

    for split in 1..MARK_ST.len() {
        let mut spacer = PromptSpacer::new();
        let chunk1 = spacer.apply(&MARK_ST[..split]);
        let chunk2 = spacer.apply(&MARK_ST[split..]);
        let mut combined = chunk1;
        combined.extend_from_slice(&chunk2);
        assert_eq!(
            combined, MARK_ST,
            "split ST at {split} diverged from expected unsplit output"
        );
    }
}

#[test]
fn mark_split_with_prior_content() {
    for split in 1..MARK_BEL.len() {
        let mut spacer = PromptSpacer::new();
        let mut first = b"out\r\n".to_vec();
        first.extend_from_slice(&MARK_BEL[..split]);
        let chunk1 = spacer.apply(&first);
        let chunk2 = spacer.apply(&MARK_BEL[split..]);
        let mut combined = chunk1;
        combined.extend_from_slice(&chunk2);
        assert_eq!(
            combined, b"out\r\n\r\n\x1b]133;A;termul\x07\r\n",
            "content split at {split} diverged"
        );
    }
}

#[test]
fn byte_per_chunk_feeding() {
    let mut spacer = PromptSpacer::new();
    let mut output = Vec::new();
    for &b in b"out\r\n" {
        output.extend_from_slice(&spacer.apply(&[b]));
    }
    for &b in MARK_BEL {
        output.extend_from_slice(&spacer.apply(&[b]));
    }
    assert_eq!(output, b"out\r\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn empty_chunks_do_not_interrupt_matching() {
    let mut spacer = PromptSpacer::new();
    let c1 = spacer.apply(b"\x1b]133;A;");
    let c2 = spacer.apply(b"");
    let c3 = spacer.apply(b"termul\x07");
    let mut combined = c1;
    combined.extend_from_slice(&c2);
    combined.extend_from_slice(&c3);
    assert_eq!(combined, MARK_BEL);
}

#[test]
fn divergence_preserves_bytes_and_restarts_candidate() {
    let mut spacer = PromptSpacer::new();
    // Incomplete prefix then 'x', followed by valid mark
    let mut input = b"\x1b]133;A;termx".to_vec();
    input.extend_from_slice(MARK_BEL);
    let out = spacer.apply(&input);
    let mut expected = b"\x1b]133;A;termx".to_vec();
    expected.extend_from_slice(MARK_BEL);
    assert_eq!(out, expected);

    // Incomplete prefix ending with ESC, then valid mark
    let mut spacer2 = PromptSpacer::new();
    let mut input2 = b"\x1b]133;A;term".to_vec();
    input2.extend_from_slice(MARK_BEL);
    let out2 = spacer2.apply(&input2);
    let mut expected2 = b"\x1b]133;A;term".to_vec();
    expected2.extend_from_slice(MARK_BEL);
    assert_eq!(out2, expected2);
}

#[test]
fn st_divergence_preserves_bytes() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"\x1b]133;A;termul\x1bx");
    assert_eq!(out, b"\x1b]133;A;termul\x1bx");
}

#[test]
fn divergence_at_len_15_restarts_candidate_and_preserves_spacing() {
    let mut spacer = PromptSpacer::new();
    let mut input = b"out\n\x1b]133;A;termul".to_vec();
    input.extend_from_slice(MARK_BEL);
    let out = spacer.apply(&input);
    let expected = b"out\n\x1b]133;A;termul\r\n\x1b]133;A;termul\x07\r\n";
    assert_eq!(out, expected);

    // Also feed one byte per chunk
    let mut spacer2 = PromptSpacer::new();
    let mut byte_output = Vec::new();
    for &b in &input {
        byte_output.extend_from_slice(&spacer2.apply(&[b]));
    }
    assert_eq!(byte_output, expected);
}

#[test]
fn flag_reset_after_mark() {
    let mut spacer = PromptSpacer::new();
    spacer.apply(b"out\r\n");
    assert!(spacer.content_since_mark());
    spacer.apply(MARK_BEL);
    assert!(!spacer.content_since_mark());
    assert!(!spacer.line_dirty());
}

// R3-1 (a): Printable with no LF, then mark -> NO spacing.
#[test]
fn r3_1_a_printable_without_lf_is_not_spaced() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"abc\x1b]133;A;termul\x07");
    assert_eq!(out, b"abc\x1b]133;A;termul\x07");
}

// R3-1 (b): Exact zsh PROMPT_SP sequence -> NO spacing.
#[test]
fn r3_1_b_zsh_prompt_sp_is_not_spaced() {
    let mut spacer = PromptSpacer::new();
    let mut prompt_sp = b"%".to_vec();
    prompt_sp.extend_from_slice(&[b' '; 79]);
    prompt_sp.extend_from_slice(b"\r \r");
    prompt_sp.extend_from_slice(MARK_BEL);

    let out = spacer.apply(&prompt_sp);
    assert_eq!(out, prompt_sp);

    // Same after a real completed line in an earlier prompt cycle
    let mut spacer2 = PromptSpacer::new();
    let cycle1 = spacer2.apply(b"earlier\r\n\x1b]133;A;termul\x07");
    assert_eq!(cycle1, b"earlier\r\n\r\n\x1b]133;A;termul\x07\r\n");

    let cycle2 = spacer2.apply(&prompt_sp);
    assert_eq!(cycle2, prompt_sp);
}

// R3-1 (c): LF arriving in the next chunk.
#[test]
fn r3_1_c_lf_in_next_chunk() {
    let mut s1 = PromptSpacer::new();
    let c1 = s1.apply(b"out");
    let c2 = s1.apply(b"\n");
    let c3 = s1.apply(MARK_BEL);
    let mut res1 = c1;
    res1.extend_from_slice(&c2);
    res1.extend_from_slice(&c3);
    assert_eq!(res1, b"out\n\r\n\x1b]133;A;termul\x07\r\n");

    let mut s2 = PromptSpacer::new();
    let c2_1 = s2.apply(b"out");
    let c2_2 = s2.apply(MARK_BEL);
    let mut res2 = c2_1;
    res2.extend_from_slice(&c2_2);
    assert_eq!(res2, b"out\x1b]133;A;termul\x07");
}

// R3-1 (d): Clear resets both flags.
#[test]
fn r3_1_d_clear_resets_both_flags() {
    let mut s1 = PromptSpacer::new();
    let out1 = s1.apply(b"out\r\n\x1b[H\x1b[2J\x1b]133;A;termul\x07");
    assert_eq!(out1, b"out\r\n\x1b[H\x1b[2J\x1b]133;A;termul\x07");

    let mut s2 = PromptSpacer::new();
    let out2 = s2.apply(b"out\r\n\x1b[3J\x1b]133;A;termul\x07");
    assert_eq!(out2, b"out\r\n\x1b[3J\x1b]133;A;termul\x07");

    let mut s3 = PromptSpacer::new();
    let out3 = s3.apply(b"out\r\n\x1bc\x1b]133;A;termul\x07");
    assert_eq!(out3, b"out\r\n\x1bc\x1b]133;A;termul\x07");

    // out + 2J + \n: line_dirty cleared by 2J, so \n does not set content_since_mark
    let mut s4 = PromptSpacer::new();
    let out4 = s4.apply(b"out\x1b[2J\n\x1b]133;A;termul\x07");
    assert_eq!(out4, b"out\x1b[2J\n\x1b]133;A;termul\x07");

    // 1J and J do NOT reset flags
    let mut s5 = PromptSpacer::new();
    let out5 = s5.apply(b"out\r\n\x1b[1J\x1b]133;A;termul\x07");
    assert_eq!(out5, b"out\r\n\x1b[1J\r\n\x1b]133;A;termul\x07\r\n");

    let mut s6 = PromptSpacer::new();
    let out6 = s6.apply(b"out\r\n\x1b[J\x1b]133;A;termul\x07");
    assert_eq!(out6, b"out\r\n\x1b[J\r\n\x1b]133;A;termul\x07\r\n");
}

// R3-1 (e): CR does not clear line_dirty.
#[test]
fn r3_1_e_cr_does_not_clear_line_dirty() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"50%\r100%\n\x1b]133;A;termul\x07");
    assert_eq!(out, b"50%\r100%\n\r\n\x1b]133;A;termul\x07\r\n");
}

// R3-3: DCS and other string sequences do not count as content.
#[test]
fn r3_3_dcs_sos_pm_apc_payload_is_not_content() {
    for intro in [b"\x1bP", b"\x1bX", b"\x1b^", b"\x1b_"] {
        let mut spacer = PromptSpacer::new();
        let mut input = intro.to_vec();
        input.extend_from_slice(b"$qm\x1b\\\n");
        input.extend_from_slice(MARK_BEL);
        let out = spacer.apply(&input);
        assert_eq!(out, input, "intro {intro:?} counted as content");
    }
}

#[test]
fn r3_3_dcs_terminator_split_across_chunks() {
    let mut spacer = PromptSpacer::new();
    let c1 = spacer.apply(b"\x1bPpayload\x1b");
    let c2 = spacer.apply(b"\\\n\x1b]133;A;termul\x07");
    let mut out = c1;
    out.extend_from_slice(&c2);
    assert_eq!(out, b"\x1bPpayload\x1b\\\n\x1b]133;A;termul\x07");

    let next = spacer.apply(b"x\n\x1b]133;A;termul\x07");
    assert_eq!(next, b"x\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn r3_3_esc_inter() {
    let mut spacer = PromptSpacer::new();
    let out1 = spacer.apply(b"\x1b(B\n\x1b]133;A;termul\x07");
    assert_eq!(out1, b"\x1b(B\n\x1b]133;A;termul\x07");

    let mut spacer2 = PromptSpacer::new();
    let out2 = spacer2.apply(b"\x1b(Bx\n\x1b]133;A;termul\x07");
    assert_eq!(out2, b"\x1b(Bx\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn r3_3_can_and_sub_cancellation() {
    // CAN cancels CSI, then x\n is content
    let mut s1 = PromptSpacer::new();
    let out1 = s1.apply(b"\x1b[12\x18x\n\x1b]133;A;termul\x07");
    assert_eq!(out1, b"\x1b[12\x18x\n\r\n\x1b]133;A;termul\x07\r\n");

    // SUB cancels OSC, title was never content
    let mut s2 = PromptSpacer::new();
    let out2 = s2.apply(b"\x1b]0;title\x1a\n\x1b]133;A;termul\x07");
    assert_eq!(out2, b"\x1b]0;title\x1a\n\x1b]133;A;termul\x07");
}

#[test]
fn r3_3_esc_abandoning_sequence() {
    // ESC abandons CSI: \x1b[12 is abandoned, \x1b[2J clears flags
    let mut s1 = PromptSpacer::new();
    let out1 = s1.apply(b"out\r\n\x1b[12\x1b[2J\x1b]133;A;termul\x07");
    assert_eq!(out1, b"out\r\n\x1b[12\x1b[2J\x1b]133;A;termul\x07");

    // ESC abandons OSC: \x1b]0;ti is abandoned, \x1b[31m is color, then x\n is content
    let mut s2 = PromptSpacer::new();
    let out2 = s2.apply(b"\x1b]0;ti\x1b[31mx\n\x1b]133;A;termul\x07");
    assert_eq!(out2, b"\x1b]0;ti\x1b[31mx\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn r3_3_osc_with_st_split_across_chunks() {
    let mut spacer = PromptSpacer::new();
    let c1 = spacer.apply(b"\x1b]0;t\x1b");
    let c2 = spacer.apply(b"\\x\n\x1b]133;A;termul\x07");
    let mut out = c1;
    out.extend_from_slice(&c2);
    assert_eq!(out, b"\x1b]0;t\x1b\\x\n\r\n\x1b]133;A;termul\x07\r\n");
}

#[test]
fn r3_3_csi_params_never_count_as_content() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"\x1b[38;5;196m\n\x1b]133;A;termul\x07");
    assert_eq!(out, b"\x1b[38;5;196m\n\x1b]133;A;termul\x07");
}

// R3-4: Visible prompt with Enter echo counts as completed visible line.
#[test]
fn r3_4_visible_prompt_with_enter_is_spaced() {
    let mut spacer = PromptSpacer::new();
    let out = spacer.apply(b"prompt$ \r\n\x1b]133;A;termul\x07");
    assert_eq!(out, b"prompt$ \r\n\r\n\x1b]133;A;termul\x07\r\n");
}

struct DeliverFixture {
    gate: Arc<SessionGate>,
    filter: SessionFilter,
    pending: Mutex<Vec<u8>>,
    hub: TerminalEventHub,
}

impl DeliverFixture {
    fn new(session_id: &str, nonce: &str) -> Self {
        let (_writer, gate) = capture_gate();
        assert!(gate.register_session(session_id.into(), nonce.into()));
        let mut filter = SessionFilter::new();
        filter.set_registered_nonce(Some(nonce.into()));
        Self {
            gate: Arc::new(gate),
            filter,
            pending: Mutex::new(Vec::new()),
            hub: TerminalEventHub::standalone(),
        }
    }

    fn unregistered() -> Self {
        let (_writer, gate) = capture_gate();
        Self {
            gate: Arc::new(gate),
            filter: SessionFilter::new(),
            pending: Mutex::new(Vec::new()),
            hub: TerminalEventHub::standalone(),
        }
    }

    fn send(&mut self, chunk: &[u8]) {
        assert!(process_reader_chunk(
            &mut self.filter,
            chunk,
            &self.pending,
            &self.gate,
            "test",
            &self.hub,
        ));
    }
}

fn session_frame(prefix: &[u8], payload: serde_json::Value) -> Vec<u8> {
    let mut chunk = prefix.to_vec();
    chunk.extend(format!("\x1b]9477;{payload}\x07").into_bytes());
    chunk
}

fn prompt_ready_chunk(prefix: &[u8], cwd: &str) -> Vec<u8> {
    session_frame(
        prefix,
        serde_json::json!({
            "type": "PromptReady",
            "nonce": "n1",
            "prompt_generation": 8,
            "cwd": cwd,
            "line_empty": true,
            "prompt_suppressed": true
        }),
    )
}

fn completion_chunk(prefix: &[u8], cwd: &str) -> Vec<u8> {
    session_frame(
        prefix,
        serde_json::json!({
            "type": "Completion", "session_id": "s1", "nonce": "n1",
            "request_id": "r1", "buffer_revision": 3, "cursor": 4,
            "prompt_generation": 7, "cwd": cwd, "output": "branch-output\n"
        }),
    )
}

// Deliver-level tests via process_reader_chunk
#[tokio::test]
async fn deliver_process_reader_chunk_with_prompt_ready_frame() {
    let mut fix = DeliverFixture::new("s1", "n1");
    fix.send(b"ls-out\r\n");

    let chunk = prompt_ready_chunk(MARK_BEL, "/repo/next");
    fix.send(&chunk);

    assert_eq!(
        *fix.pending.lock().expect("pending"),
        b"ls-out\r\n\r\n\x1b]133;A;termul\x07\r\n"
    );
    assert!(fix.gate.trusted_at_prompt());
    assert_eq!(
        fix.gate.trusted_prompt_snapshot(),
        Some((8, "/repo/next".to_string()))
    );
}

#[tokio::test]
async fn deliver_suppression_content_does_not_space_subsequent_prompt() {
    let mut fix = DeliverFixture::new("s1", "n1");

    // Start completion (suppression becomes active)
    let start = start_completion(&fix.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert!(fix.gate.suppressing_output());

    // Terminal bytes emitted between suppression start and closing frame
    fix.send(b"prior-hidden\r\n");

    // Chunk arriving during suppression: hidden terminal bytes emitted in the
    // SAME chunk as the closing completion frame
    let completion_chunk = completion_chunk(b"hidden\r\n", "/repo");
    fix.send(&completion_chunk);

    // Suppression ended with completion
    assert!(!fix.gate.suppressing_output());

    // Prompt arrives without visible forwarded content since mark
    let prompt_chunk = prompt_ready_chunk(MARK_BEL, "/repo");
    fix.send(&prompt_chunk);

    // Prompt is NOT spaced and suppressed terminal bytes are not forwarded
    assert_eq!(*fix.pending.lock().expect("pending"), MARK_BEL);
}

#[tokio::test]
async fn deliver_cancellation_suppression_content_does_not_space_subsequent_prompt() {
    let mut fix = DeliverFixture::new("s1", "n1");

    // Start completion (suppression becomes active)
    let start = start_completion(&fix.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert!(fix.gate.suppressing_output());

    // Terminal bytes emitted while suppressed before cancellation
    fix.send(b"prior-hidden\r\n");

    // Cancel completion (suppression is retained until closing frame)
    assert!(fix.gate.cancel_completion("r1"));
    assert!(fix.gate.suppressing_output());

    // Closing completion frame arrives with hidden terminal bytes in the same chunk
    let completion_chunk = completion_chunk(b"hidden\r\n", "/repo");
    fix.send(&completion_chunk);

    // Suppression ended with completion frame
    assert!(!fix.gate.suppressing_output());

    // Prompt arrives without visible forwarded content since mark
    let prompt_chunk = prompt_ready_chunk(MARK_BEL, "/repo");
    fix.send(&prompt_chunk);

    // Prompt is NOT spaced and suppressed terminal bytes are not forwarded
    assert_eq!(*fix.pending.lock().expect("pending"), MARK_BEL);
}

#[tokio::test]
async fn deliver_r3_1_a_printable_without_lf() {
    let mut fix = DeliverFixture::unregistered();
    fix.send(b"abc");
    fix.send(MARK_BEL);

    assert_eq!(
        *fix.pending.lock().expect("pending"),
        b"abc\x1b]133;A;termul\x07"
    );
}

#[tokio::test]
async fn deliver_r3_1_b_zsh_prompt_sp() {
    let mut fix = DeliverFixture::unregistered();

    let mut prompt_sp = b"%".to_vec();
    prompt_sp.extend_from_slice(&[b' '; 79]);
    prompt_sp.extend_from_slice(b"\r \r");

    fix.send(&prompt_sp);
    fix.send(MARK_BEL);

    let mut expected = prompt_sp;
    expected.extend_from_slice(MARK_BEL);
    assert_eq!(*fix.pending.lock().expect("pending"), expected);
}
