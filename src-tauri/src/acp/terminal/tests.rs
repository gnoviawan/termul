use super::*;

#[test]
fn no_truncation_under_limit() {
    let (out, trunc) = truncate_front_to_char_boundary(b"hello", 10);
    assert_eq!(out, b"hello");
    assert!(!trunc);
}

#[test]
fn truncates_from_front() {
    let (out, trunc) = truncate_front_to_char_boundary(b"0123456789", 4);
    assert!(trunc);
    assert_eq!(String::from_utf8(out).unwrap(), "6789");
}

#[test]
fn truncation_respects_utf8_char_boundary() {
    // 'a' (1 byte) + three 'é' (2 bytes each) = 7 bytes. A tight front cut
    // could land mid-codepoint; we must advance to a leading byte.
    let s = "aééé".as_bytes();
    let (out, trunc) = truncate_front_to_char_boundary(s, 5);
    assert!(trunc);
    let decoded = String::from_utf8(out).expect("valid utf-8 after truncation");
    assert!(decoded.len() <= 5);
    assert!(decoded.chars().all(|c| c == 'é'));
}

#[test]
fn buffer_caps_and_flags_truncation() {
    let mut buf = TerminalBuffer {
        limit: Some(4),
        ..TerminalBuffer::default()
    };
    buf.append(b"abcdef");
    let (out, trunc) = buf.snapshot();
    assert!(trunc);
    assert_eq!(out, "cdef");
}

#[cfg(unix)]
#[tokio::test]
async fn running_count_counts_only_commands_that_are_still_running() {
    let mut registry = TerminalRegistry::new();
    assert_eq!(registry.running_count(), 0);

    let long = registry
        .create("sleep", &["30".to_string()], &[], None, None)
        .expect("spawn sleep");
    let short = registry
        .create("true", &[], &[], None, None)
        .expect("spawn true");

    // `true` exits on its own; the count observes that without any poll.
    let mut count = registry.running_count();
    for _ in 0..100 {
        if count == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        count = registry.running_count();
    }
    assert_eq!(count, 1, "only the long-running command counts");
    assert!(registry.cached_exit(&short).is_some());

    registry.kill(&long).expect("kill");
    let mut count = registry.running_count();
    for _ in 0..100 {
        if count == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        count = registry.running_count();
    }
    assert_eq!(count, 0, "a killed command stops counting");
    registry.release_all();
}
