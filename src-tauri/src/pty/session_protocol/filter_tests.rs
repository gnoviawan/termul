use super::filter::{FilterResult, SessionFilter};
use super::frame::Frame;
use super::TERMUL_SESSION_OSC;

pub(super) fn session_osc(payload: &str) -> Vec<u8> {
    let mut bytes = format!("\u{1b}]{TERMUL_SESSION_OSC};{payload}").into_bytes();
    bytes.push(0x07);
    bytes
}

fn contains_session_ident(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes).contains(&TERMUL_SESSION_OSC.to_string())
}

fn expect_forwarded(result: FilterResult) -> (Vec<u8>, Vec<Frame>) {
    match result {
        FilterResult::Forwarded { bytes, frames } => (bytes, frames),
        result => panic!("expected forwarded output, got {result:?}"),
    }
}

fn process_split(input: &[u8], split: usize) -> [(Vec<u8>, Vec<Frame>); 2] {
    let mut filter = SessionFilter::new();
    [
        expect_forwarded(filter.process(&input[..split])),
        expect_forwarded(filter.process(&input[split..])),
    ]
}

pub(super) fn oversized_candidate() -> Vec<u8> {
    let mut candidate = b"\x1b]9477;".to_vec();
    candidate.extend(std::iter::repeat_n(
        b'x',
        super::filter::MAX_SESSION_FRAME_BYTES,
    ));
    candidate
}

#[test]
fn bare_session_ident_is_dropped() {
    for (ending, expected) in [
        (&b"\x07"[..], &b"before after"[..]),
        (&b"\x1b\\"[..], &b"before after"[..]),
        (&b"\x18"[..], &b"before after"[..]),
        (&b"\x1a"[..], &b"before after"[..]),
        (&b"\x1b[0m"[..], &b"before \x1b[0mafter"[..]),
    ] {
        let mut input = b"before \x1b]9477".to_vec();
        input.extend_from_slice(ending);
        input.extend_from_slice(b"after");
        let mut filter = SessionFilter::new();
        assert_eq!(
            filter.process(&input),
            FilterResult::Forwarded {
                bytes: expected.to_vec(),
                frames: vec![],
            },
            "ending {ending:?}"
        );
        for split in 0..=input.len() {
            let mut forwarded = Vec::new();
            for (bytes, frames) in process_split(&input, split) {
                assert!(frames.is_empty(), "ending {ending:?}, split {split}");
                assert!(!contains_session_ident(&bytes));
                forwarded.extend(bytes);
            }
            assert_eq!(forwarded, expected, "ending {ending:?}, split {split}");
        }
    }
}

#[test]
fn foreign_ident_prefix_is_forwarded() {
    for input in [&b"\x1b]94770;x\x07"[..], &b"\x1b]9477a\x07"[..]] {
        let mut filter = SessionFilter::new();
        assert_eq!(
            filter.process(input),
            FilterResult::Forwarded {
                bytes: input.to_vec(),
                frames: vec![],
            }
        );
        for split in 0..=input.len() {
            let mut forwarded = Vec::new();
            for (bytes, frames) in process_split(input, split) {
                assert!(frames.is_empty());
                forwarded.extend(bytes);
            }
            assert_eq!(forwarded, input, "foreign ident, split {split}");
        }
    }
}

#[test]
fn unsynchronizable_stream_reports_desync() {
    use super::filter::MAX_SESSION_FRAME_BYTES;

    let mut input = b"before \x1b]9477;{\"type\":\"CommandFinished\",\"pad\":\"".to_vec();
    input.extend(std::iter::repeat_n(b'x', MAX_SESSION_FRAME_BYTES + 1));
    input.extend_from_slice(b"\"}\x07 after");
    let mut filter = SessionFilter::new();
    let mut forwarded = Vec::new();
    let chunks: Vec<_> = input.chunks(4096).collect();

    for (index, chunk) in chunks.iter().enumerate() {
        let result = filter.process(chunk);
        let bytes = if index + 1 == chunks.len() {
            let FilterResult::Desync { bytes } = result else {
                panic!("an oversized frame must end with desync, got {result:?}");
            };
            bytes
        } else {
            let (bytes, frames) = expect_forwarded(result);
            assert!(frames.is_empty(), "unfinished frame emitted session frames");
            bytes
        };
        assert!(!bytes.contains(&b'x'), "forwarded oversized payload");
        assert!(!bytes.contains(&0x1b), "forwarded ESC");
        assert!(!contains_session_ident(&bytes), "forwarded session ident");
        forwarded.extend_from_slice(&bytes);
    }
    assert_eq!(forwarded, b"before  after");
    assert_eq!(
        filter.process(b"tail"),
        FilterResult::Forwarded {
            bytes: b"tail".to_vec(),
            frames: vec![],
        }
    );
}

#[test]
fn complete_frame_is_removed() {
    let payload = r#"{"type":"CommandFinished","exit_code":2}"#;
    let mut input = b"hello ".to_vec();
    input.extend(session_osc(payload));
    input.extend_from_slice(b"world");

    let mut filter = SessionFilter::new();
    let (bytes, frames) = expect_forwarded(filter.process(&input));
    assert_eq!(bytes, b"hello world");
    assert_eq!(
        frames,
        vec![Frame::CommandFinished {
            nonce: None,
            exit_code: Some(2)
        }]
    );
    assert!(
        !contains_session_ident(&bytes),
        "forwarded bytes still contain the session ident"
    );
    assert!(
        !bytes.windows(2).any(|window| window == b"\x1b]"),
        "forwarded bytes still contain the OSC introducer"
    );
}

#[test]
fn split_frame_is_not_forwarded() {
    let frame = session_osc(r#"{"type":"CommandFinished","exit_code":0}"#);
    let mut input = b"before ".to_vec();
    input.extend_from_slice(&frame);
    input.extend_from_slice(b" after");

    for split in 1..frame.len() {
        let split_index = b"before ".len() + split;
        let [(first_bytes, first_frames), (second_bytes, second_frames)] =
            process_split(&input, split_index);

        assert!(first_frames.is_empty(), "split {split}: first frames");
        assert_eq!(first_bytes, b"before ", "split {split}: first bytes");
        assert_eq!(
            second_frames,
            vec![Frame::CommandFinished {
                nonce: None,
                exit_code: Some(0)
            }],
            "split {split}: second frames"
        );
        assert_eq!(second_bytes, b" after", "split {split}: second bytes");
        for bytes in [&first_bytes, &second_bytes] {
            assert!(!bytes.contains(&0x1b), "split {split}: forwarded ESC");
            assert!(
                !contains_session_ident(bytes),
                "split {split}: forwarded session ident"
            );
        }
    }
}

#[test]
fn malformed_frame_is_dropped() {
    for (name, abort, expected) in [
        ("CAN", &b"\x18"[..], &b"before after"[..]),
        ("SUB", &b"\x1a"[..], &b"before after"[..]),
        ("ESC", &b"\x1b[0m"[..], &b"before \x1b[0mafter"[..]),
    ] {
        let mut truncated = session_osc(r#"{"type":"Comm"#);
        truncated.pop(); // Remove BEL to leave the payload unterminated.
        let mut input = b"before ".to_vec();
        input.extend_from_slice(&truncated);
        input.extend_from_slice(abort);
        input.extend_from_slice(b"after");

        let mut filter = SessionFilter::new();
        let (bytes, frames) = expect_forwarded(filter.process(&input));

        assert!(frames.is_empty(), "{name}: emitted frames");
        assert!(!contains_session_ident(&bytes), "{name}: session ident");
        assert!(
            !bytes.windows(5).any(|window| window == b"\"Comm"),
            "{name}: truncated payload"
        );
        assert!(bytes.starts_with(b"before "), "{name}: missing prefix");
        assert!(bytes.ends_with(b"after"), "{name}: missing suffix");
        assert_eq!(bytes, expected, "{name}: forwarded bytes");

        let (bytes, frames) = expect_forwarded(filter.process(b"tail"));
        assert_eq!(bytes, b"tail", "{name}: sync lost");
        assert!(frames.is_empty(), "{name}: emitted frames after abort");
    }
}

#[test]
fn ambient_bytes_are_forwarded() {
    let input = b"\x1b]133;A\x07\x1b]133;D;0\x1b\\__TERMUL_EXIT__:0\r\n";
    let mut filter = SessionFilter::new();
    let (bytes, frames) = expect_forwarded(filter.process(input));
    assert_eq!(bytes, input);
    assert!(frames.is_empty());

    for split in 0..=input.len() {
        let [(mut first_bytes, first_frames), (second_bytes, second_frames)] =
            process_split(input, split);
        first_bytes.extend_from_slice(&second_bytes);
        assert_eq!(first_bytes, input, "split {split}: forwarded bytes");
        assert!(first_frames.is_empty(), "split {split}: first frames");
        assert!(second_frames.is_empty(), "split {split}: second frames");
    }

    let mut mixed = b"\x1b]133;A\x07".to_vec();
    mixed.extend(session_osc(r#"{"type":"CommandFinished","exit_code":0}"#));
    mixed.extend_from_slice(b"\x1b]133;D;0\x1b\\__TERMUL_EXIT__:0\r\n");
    let mut filter = SessionFilter::new();
    let (bytes, frames) = expect_forwarded(filter.process(&mixed));
    assert_eq!(bytes, input);
    assert_eq!(
        frames,
        vec![Frame::CommandFinished {
            nonce: None,
            exit_code: Some(0)
        }]
    );
}

#[test]
fn command_started_frame_is_returned_to_the_caller() {
    let mut input = b"a".to_vec();
    input.extend(session_osc(r#"{"type":"CommandStarted","nonce":"n1"}"#));
    input.extend_from_slice(b"b");

    let mut filter = SessionFilter::new();
    let (bytes, frames) = expect_forwarded(filter.process(&input));
    assert_eq!(bytes, b"ab");
    assert_eq!(
        frames,
        vec![Frame::CommandStarted {
            nonce: Some("n1".into())
        }]
    );
}

#[test]
fn completion_frame_is_returned_to_the_caller() {
    let mut input = b"a".to_vec();
    input.extend(session_osc(
        r#"{"type":"Completion","session_id":"s1","nonce":"n1","request_id":"r1","buffer_revision":3,"cursor":4,"prompt_generation":7,"cwd":"/repo","output":"status"}"#,
    ));
    input.extend_from_slice(b"b");

    let mut filter = SessionFilter::new();
    let (bytes, frames) = expect_forwarded(filter.process(&input));
    assert_eq!(bytes, b"ab");
    assert_eq!(
        frames,
        vec![Frame::Completion(super::frame::CompletionResult {
            session_id: "s1".into(),
            nonce: "n1".into(),
            request_id: "r1".into(),
            buffer_revision: 3,
            cursor: 4,
            prompt_generation: 7,
            cwd: "/repo".into(),
            output: "status".into()
        })]
    );
}
