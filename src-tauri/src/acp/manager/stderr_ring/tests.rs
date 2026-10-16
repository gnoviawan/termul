use super::*;

#[test]
fn ring_keeps_only_the_newest_lines() {
    let ring = StderrRing::new(true);
    for n in 0..(MAX_LINES + 5) {
        ring.push(&format!("line {n}"));
    }
    let tail = ring.tail();
    let lines: Vec<&str> = tail.lines().collect();
    assert_eq!(lines.len(), MAX_LINES);
    assert_eq!(lines.first().copied(), Some("line 5"));
    assert_eq!(
        lines.last().copied(),
        Some(format!("line {}", MAX_LINES + 4).as_str())
    );
}

#[test]
fn ring_stays_inside_the_byte_bound() {
    let ring = StderrRing::new(true);
    let line = "x".repeat(MAX_LINE_BYTES);
    for _ in 0..MAX_LINES {
        ring.push(&line);
    }
    assert!(ring.tail().len() <= MAX_BYTES + MAX_LINES);
    assert!(ring.lines.lock().bytes <= MAX_BYTES);
}

#[test]
fn one_long_line_is_cut_on_a_character_boundary() {
    let ring = StderrRing::new(true);
    ring.push(&"é".repeat(MAX_LINE_BYTES));
    let tail = ring.tail();
    assert!(tail.len() <= MAX_LINE_BYTES);
    assert!(tail.chars().all(|c| c == 'é'));
}

#[test]
fn blank_lines_are_skipped() {
    let ring = StderrRing::new(true);
    ring.push("");
    ring.push("   \r");
    assert_eq!(ring.tail(), "");
}

#[test]
fn ring_that_does_not_capture_stores_nothing() {
    let ring = StderrRing::new(false);
    ring.push("ANTHROPIC_API_KEY=sk-ant-0123456789abcdef0123");
    ring.push("plain line");
    assert_eq!(ring.tail(), "");
    assert_eq!(ring.tail_within(DETAIL_TAIL_BYTES), "");
}

#[test]
fn secret_looking_text_is_masked_before_storage() {
    let ring = StderrRing::new(true);
    for line in [
        "Authorization: Bearer abcdef1234567890abcdef",
        "ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdef0123",
        r#"{"access_token": "abc.def.ghi-123456"}"#,
        "password = hunter2hunter2",
        "using ghp_0123456789abcdefghij0123456789abcdef now",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ] {
        ring.push(line);
    }
    let tail = ring.tail();
    for fragment in [
        "abcdef1234567890abcdef",
        "sk-ant-api03",
        "abc.def.ghi-123456",
        "hunter2hunter2",
        "ghp_0123456789",
        "eyJhbGciOi",
    ] {
        assert!(!tail.contains(fragment), "masked text kept {fragment}");
    }
    assert!(tail.contains(MASK));
}

#[test]
fn ordinary_diagnostics_survive_redaction() {
    let line = "Error: Cannot find module '/opt/agent/dist/index.js' (code MODULE_NOT_FOUND)";
    assert_eq!(redact_line(line), line);
    let line = "token budget exceeded for this request";
    assert_eq!(redact_line(line), line);
}

#[test]
fn tail_within_keeps_whole_newest_lines() {
    let ring = StderrRing::new(true);
    ring.push("first line");
    ring.push("second line");
    ring.push("third line");
    assert_eq!(
        ring.tail_within(1024),
        "first line\nsecond line\nthird line"
    );
    assert_eq!(ring.tail_within(23), "second line\nthird line");
    assert_eq!(ring.tail_within(10), "third line");
    assert_eq!(ring.tail_within(9), "hird line");
}

#[test]
fn basename_drops_directories_on_both_separators() {
    assert_eq!(
        command_basename("/usr/local/bin/claude-agent-acp"),
        "claude-agent-acp"
    );
    assert_eq!(
        command_basename(r"C:\Program Files\agent\agent.exe"),
        "agent.exe"
    );
    assert_eq!(command_basename("npx"), "npx");
    assert_eq!(command_basename("  /opt/agent/  "), "agent");
}

#[test]
fn failure_message_embeds_the_tail_only_when_there_is_one() {
    let ring = StderrRing::new(true);
    assert_eq!(
        with_stderr_tail("agent failed to start".into(), &ring),
        "agent failed to start"
    );
    ring.push("node: command not found");
    assert_eq!(
        with_stderr_tail("agent failed to start".into(), &ring),
        "agent failed to start\nagent stderr:\nnode: command not found"
    );
}

#[test]
fn failure_message_masks_stderr_the_sdk_folded_into_it() {
    let ring = StderrRing::new(false);
    let message = with_stderr_tail(
        "agent failed to start: exit 1: ANTHROPIC_API_KEY=sk-ant-0123456789abcdef0123".into(),
        &ring,
    );
    assert!(!message.contains("sk-ant-0123456789"), "{message}");
    assert!(message.starts_with("agent failed to start: exit 1:"));
}

#[test]
fn credential_straddling_the_line_cut_is_masked_whole() {
    let ring = StderrRing::new(true);
    // The token starts at byte 511: a cut at 512 would leave one character,
    // too short for the bearer pattern, unless the whole line is masked first.
    let padding = "x ".repeat(252);
    ring.push(&format!("{padding}Bearer abcdef1234567890abcdef"));
    let tail = ring.tail();
    assert!(!tail.contains("Bearer a"), "bearer prefix kept in the tail");
}
