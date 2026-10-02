use super::*;

#[test]
fn test_passthrough_regular_text() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"hello world\n", &mut out, |r| {
        responses.extend_from_slice(r)
    });

    assert_eq!(
        out, b"hello world\n",
        "regular text should pass through unchanged"
    );
    assert!(responses.is_empty(), "no DA responses for regular text");
}

#[test]
fn test_da1_query() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"\x1b[c", &mut out, |r| responses.extend_from_slice(r));

    assert_eq!(responses, DA1_RESPONSE, "DA1 should trigger response");
    assert_eq!(out, b"\x1b[c", "DA1 bytes should pass through");
}

#[test]
fn test_da2_query() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"\x1b[>c", &mut out, |r| responses.extend_from_slice(r));

    assert_eq!(responses, DA2_RESPONSE, "DA2 should trigger response");
    assert_eq!(out, b"\x1b[>c", "DA2 bytes should pass through");
}

#[test]
fn test_da3_query_passes_through() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"\x1b[=c", &mut out, |r| responses.extend_from_slice(r));

    assert!(responses.is_empty(), "DA3 should not trigger a response");
    // Spec I/O matrix: "Silent drop (no response), pass through"
    assert_eq!(out, b"\x1b[=c", "DA3 bytes should pass through to frontend");
}

#[test]
fn test_non_da_csi() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"\x1b[H", &mut out, |r| responses.extend_from_slice(r));
    // Cursor home

    assert!(
        responses.is_empty(),
        "non-DA CSI should not trigger response"
    );
    assert_eq!(out, b"\x1b[H", "non-DA CSI should pass through");
}

#[test]
fn test_multiple_csi_mixed() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // \x1b[H = cursor home, \x1b[c = DA1, \x1b[J = erase display
    filter.process(b"\x1b[H\x1b[c\x1b[J", &mut out, |r| {
        responses.extend_from_slice(r)
    });

    assert_eq!(
        responses, DA1_RESPONSE,
        "should respond to DA1 among other CSI"
    );
    assert_eq!(
        out, b"\x1b[H\x1b[c\x1b[J",
        "all CSI sequences should pass through"
    );
}

#[test]
fn test_multiple_da_in_one_chunk() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"\x1b[c\x1b[>c", &mut out, |r| {
        responses.extend_from_slice(r)
    });

    let expected_responses = [DA1_RESPONSE, DA2_RESPONSE].concat();
    assert_eq!(
        responses, expected_responses,
        "both DA1 and DA2 should trigger responses"
    );
    assert_eq!(
        out, b"\x1b[c\x1b[>c",
        "both DA sequences should pass through"
    );
}

#[test]
fn test_da_response_from_terminal() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // \x1b[?1;2c is the response a terminal sends BACK (not a query)
    filter.process(b"\x1b[?1;2c", &mut out, |r| responses.extend_from_slice(r));

    assert!(
        responses.is_empty(),
        "terminal DA response should not trigger another response"
    );
    assert_eq!(
        out, b"\x1b[?1;2c",
        "terminal DA response should pass through"
    );
}

#[test]
fn test_split_across_chunks_no_hold_completion() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // First chunk ends with ESC (0x1b)
    filter.process(b"before\x1b", &mut out, |r| responses.extend_from_slice(r));

    assert_eq!(out, b"before", "text before ESC should pass through");
    assert!(
        responses.is_empty(),
        "no response yet — sequence incomplete"
    );
    assert_eq!(
        filter.state,
        State::AfterEsc,
        "filter should be in AfterEsc state"
    );

    // Second chunk: the rest of the CSI sequence
    filter.process(b"[c", &mut out, |r| responses.extend_from_slice(r));

    assert_eq!(
        responses, DA1_RESPONSE,
        "should respond to DA1 after second chunk"
    );
    assert_eq!(
        out, b"before\x1b[c",
        "complete sequence should pass through"
    );
    assert_eq!(
        filter.state,
        State::Idle,
        "filter should return to Idle after complete sequence"
    );
}

#[test]
fn test_split_across_chunks_mid_csi() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // First chunk: \x1b[ (ESC + [)
    filter.process(b"\x1b[", &mut out, |r| responses.extend_from_slice(r));

    assert!(out.is_empty(), "no output yet — inside CSI");
    assert_eq!(
        filter.state,
        State::InsideCsi,
        "filter should be in InsideCsi state"
    );

    // Second chunk: parameter bytes + final byte
    filter.process(b"1;2H", &mut out, |r| responses.extend_from_slice(r));
    // Cursor position \x1b[1;2H

    assert!(responses.is_empty(), "cursor position is not a DA query");
    assert_eq!(out, b"\x1b[1;2H", "complete CSI should pass through");
}

#[test]
fn test_da1_with_params() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // DA1 can also be \x1b[?1;2c (which is actually a response) or \x1b[1;2c
    // But the spec says just \x1b[c for DA1 and \x1b[?1;2c for DA response
    filter.process(b"\x1b[1;2c", &mut out, |r| responses.extend_from_slice(r));

    assert_eq!(
        responses, DA1_RESPONSE,
        "DA1 with params should still trigger response"
    );
    assert_eq!(out, b"\x1b[1;2c", "DA1 with params should pass through");
}

#[test]
fn test_mixed_text_and_da() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // Simulate shell startup with TERM query then prompt
    let input = b"prompt>\x1b[c";
    filter.process(input, &mut out, |r| responses.extend_from_slice(r));

    let expected_out = &input[..];
    assert_eq!(out, expected_out, "text and DA should both pass through");
    assert_eq!(responses, DA1_RESPONSE, "DA1 should be responded to");
}

#[test]
fn test_empty_input() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    filter.process(b"", &mut out, |r| responses.extend_from_slice(r));

    assert!(out.is_empty(), "empty input produces no output");
    assert!(responses.is_empty(), "empty input produces no responses");
    assert_eq!(filter.state, State::Idle, "filter stays idle");
}

#[test]
fn test_da3_does_not_respond() {
    let mut filter = DaFilter::new();
    let mut out = Vec::new();
    let mut responses = Vec::new();

    // DA3 should NOT generate a response
    filter.process(b"\x1b[=c", &mut out, |r| responses.extend_from_slice(r));

    assert!(responses.is_empty(), "DA3 must NOT generate a response");
    // ADR spec says "pass through" for DA3
    assert_eq!(out, b"\x1b[=c", "DA3 bytes should pass through");
}
