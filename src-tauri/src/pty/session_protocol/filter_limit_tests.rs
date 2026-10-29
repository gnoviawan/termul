use super::filter::{FilterResult, SessionFilter};
use super::filter_tests::{oversized_candidate, session_osc};
use super::frame::Frame;

fn collect_resync_results(results: [FilterResult; 2]) -> (Vec<u8>, usize) {
    let mut bytes = Vec::new();
    let mut desyncs = 0;
    for result in results {
        match result {
            FilterResult::Desync { bytes: forwarded } => {
                desyncs += 1;
                bytes.extend(forwarded);
            }
            FilterResult::Forwarded {
                bytes: forwarded,
                frames,
            } => {
                assert!(frames.is_empty());
                bytes.extend(forwarded);
            }
        }
    }
    (bytes, desyncs)
}

#[test]
fn oversized_frame_endings_resync_across_chunks() {
    for (ending, expected) in [
        (&b"\x07"[..], &b"after"[..]),
        (&b"\x1b\\"[..], &b"after"[..]),
        (&b"\x18"[..], &b"after"[..]),
        (&b"\x1a"[..], &b"after"[..]),
        (&b"\x1b[0m"[..], &b"\x1b[0mafter"[..]),
    ] {
        let candidate = oversized_candidate();
        let mut suffix = ending.to_vec();
        suffix.extend_from_slice(b"after");
        for split in 0..=ending.len() {
            let mut filter = SessionFilter::new();
            assert_eq!(
                filter.process(&candidate),
                FilterResult::Forwarded {
                    bytes: vec![],
                    frames: vec![]
                }
            );
            let first = filter.process(&suffix[..split]);
            let second = filter.process(&suffix[split..]);
            let (bytes, desyncs) = collect_resync_results([first, second]);
            assert_eq!(desyncs, 1, "ending {ending:?}, split {split}");
            assert_eq!(bytes, expected, "ending {ending:?}, split {split}");
        }
    }
}

#[test]
fn oversized_frame_drops_other_frames_in_the_same_call() {
    let valid = session_osc(r#"{"type":"CommandFinished","exit_code":0}"#);
    let mut input = valid.clone();
    input.extend_from_slice(b"before ");
    input.extend(oversized_candidate());
    input.extend_from_slice(b"\x07 after");
    input.extend_from_slice(&valid);

    let mut filter = SessionFilter::new();
    assert_eq!(
        filter.process(&input),
        FilterResult::Desync {
            bytes: b"before  after".to_vec()
        }
    );
    assert_eq!(
        filter.process(&valid),
        FilterResult::Forwarded {
            bytes: vec![],
            frames: vec![Frame::CommandFinished {
                nonce: None,
                exit_code: Some(0)
            }],
        }
    );
}
