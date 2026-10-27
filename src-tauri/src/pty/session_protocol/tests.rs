use super::frame::{self, Frame, SessionRpcResult};
use super::{CLEAR_LINE_SEQUENCE, RESTORE_PROMPT_SEQUENCE, TERMUL_SESSION_OSC};

#[test]
fn protocol_ident_is_private() {
    assert_eq!(TERMUL_SESSION_OSC, 9477);
    assert_ne!(TERMUL_SESSION_OSC, 133);
    assert_ne!(TERMUL_SESSION_OSC, 633);
    assert_ne!(TERMUL_SESSION_OSC, 9278);
}

#[test]
fn prompt_frame_keeps_its_fields() {
    let payload = serde_json::json!({
        "type": "PromptReady",
        "nonce": "n1",
        "prompt_generation": 4,
        "line_empty": true,
        "prompt_suppressed": true,
        "cwd": "/repo"
    });
    let parsed = frame::parse(&payload, None).expect("prompt frame");
    let Frame::PromptReady {
        nonce,
        prompt_generation,
        line_empty,
        prompt_suppressed,
        cwd,
    } = parsed
    else {
        panic!("expected PromptReady, got {parsed:?}");
    };
    assert_eq!(nonce, "n1");
    assert_eq!(prompt_generation, 4);
    assert!(line_empty);
    assert!(prompt_suppressed);
    assert_eq!(cwd, "/repo");
}

#[test]
fn prompt_frame_requires_its_fields() {
    let fields = [
        "nonce",
        "prompt_generation",
        "line_empty",
        "prompt_suppressed",
        "cwd",
    ];
    for field in fields {
        let mut payload = serde_json::json!({
            "type": "PromptReady",
            "nonce": "n1",
            "prompt_generation": 4,
            "line_empty": true,
            "prompt_suppressed": true,
            "cwd": "/repo"
        });
        payload.as_object_mut().unwrap().remove(field);
        let parsed = frame::parse(&payload, None);
        assert!(
            !matches!(parsed, Ok(Frame::PromptReady { .. })),
            "omitted {field} must not be a prompt frame"
        );
    }
}

#[test]
fn false_prompt_flag_still_parses() {
    let payload = serde_json::json!({
        "type": "PromptReady",
        "nonce": "n1",
        "prompt_generation": 4,
        "line_empty": false,
        "prompt_suppressed": false,
        "cwd": "/repo"
    });
    let parsed = frame::parse(&payload, None).expect("false flags still parse");
    let Frame::PromptReady {
        line_empty,
        prompt_suppressed,
        nonce,
        prompt_generation,
        cwd,
    } = parsed
    else {
        panic!("expected PromptReady, got {parsed:?}");
    };
    assert!(!line_empty);
    assert!(!prompt_suppressed);
    assert_eq!(nonce, "n1");
    assert_eq!(prompt_generation, 4);
    assert_eq!(cwd, "/repo");
}

#[test]
fn command_finished_keeps_its_exit_code() {
    let payload = serde_json::json!({
        "type": "CommandFinished",
        "exit_code": 2
    });
    let parsed = frame::parse(&payload, None).expect("command finished");
    let Frame::CommandFinished { exit_code, .. } = parsed else {
        panic!("expected CommandFinished, got {parsed:?}");
    };
    assert_eq!(exit_code, Some(2));
}

#[test]
fn command_finished_may_omit_its_exit_code() {
    let payload = serde_json::json!({
        "type": "CommandFinished"
    });
    let parsed = frame::parse(&payload, None).expect("command finished without a code");
    let Frame::CommandFinished { exit_code, .. } = parsed else {
        panic!("expected CommandFinished, got {parsed:?}");
    };
    assert_eq!(exit_code, None);
}

fn parsed_exit_code(code: serde_json::Value) -> Option<i32> {
    let payload = serde_json::json!({
        "type": "CommandFinished",
        "exit_code": code
    });
    let parsed = frame::parse(&payload, None).expect("command finished");
    let Frame::CommandFinished { exit_code, .. } = parsed else {
        panic!("expected CommandFinished, got {parsed:?}");
    };
    exit_code
}

#[test]
fn command_finished_keeps_i32_exit_code_boundaries() {
    assert_eq!(
        parsed_exit_code(serde_json::json!(i32::MAX)),
        Some(i32::MAX)
    );
    assert_eq!(
        parsed_exit_code(serde_json::json!(i32::MIN)),
        Some(i32::MIN)
    );
    assert_eq!(parsed_exit_code(serde_json::json!(0)), Some(0));
    assert_eq!(parsed_exit_code(serde_json::json!(-1)), Some(-1));
}

#[test]
fn command_finished_treats_out_of_i32_range_as_absent() {
    assert_eq!(
        parsed_exit_code(serde_json::json!(i64::from(i32::MAX) + 1)),
        None
    );
    assert_eq!(
        parsed_exit_code(serde_json::json!(i64::from(i32::MIN) - 1)),
        None
    );
}

#[test]
fn init_shell_keeps_its_registration() {
    let payload = serde_json::json!({
        "type": "InitShell",
        "session_id": "s1",
        "nonce": "n1"
    });
    let parsed = frame::parse(&payload, None).expect("init shell");
    let Frame::InitShell { session_id, nonce } = parsed else {
        panic!("expected InitShell, got {parsed:?}");
    };
    assert_eq!(session_id, "s1");
    assert_eq!(nonce, "n1");
}

#[test]
fn init_shell_requires_its_registration() {
    for field in ["session_id", "nonce"] {
        let mut payload = serde_json::json!({
            "type": "InitShell",
            "session_id": "s1",
            "nonce": "n1"
        });
        payload.as_object_mut().unwrap().remove(field);
        let parsed = frame::parse(&payload, None);
        assert!(
            !matches!(parsed, Ok(Frame::InitShell { .. })),
            "omitted {field} must not be InitShell"
        );
    }
}

#[test]
fn nonce_mismatch_is_not_a_mode_signal() {
    let payload = serde_json::json!({
        "type": "PromptReady",
        "nonce": "other",
        "prompt_generation": 4,
        "line_empty": true,
        "prompt_suppressed": true,
        "cwd": "/repo"
    });
    let parsed = frame::parse(&payload, Some("registered"));
    let mode_signal = matches!(
        parsed,
        Ok(Frame::PromptReady { .. } | Frame::CommandFinished { .. })
    );
    assert!(!mode_signal, "a nonce mismatch is not a mode signal");
}

#[test]
fn clear_line_sequence_matches() {
    assert_eq!(CLEAR_LINE_SEQUENCE, "\u{1b}[99;1~");
    assert!(!CLEAR_LINE_SEQUENCE.chars().any(|c| c.is_ascii_alphabetic()));
}

#[test]
fn submit_result_names() {
    let names = [
        serde_json::to_string(&SessionRpcResult::Accepted).unwrap(),
        serde_json::to_string(&SessionRpcResult::PreWrite).unwrap(),
        serde_json::to_string(&SessionRpcResult::Partial).unwrap(),
        serde_json::to_string(&SessionRpcResult::NotStarted).unwrap(),
    ];
    assert_eq!(
        names,
        [
            "\"Accepted\"",
            "\"PreWrite\"",
            "\"Partial\"",
            "\"NotStarted\""
        ]
    );
}

#[test]
fn restore_prompt_sequence_matches() {
    assert_eq!(RESTORE_PROMPT_SEQUENCE, "\u{1b}[99;2~");
    assert_ne!(RESTORE_PROMPT_SEQUENCE, CLEAR_LINE_SEQUENCE);
}

#[test]
fn command_started_keeps_its_nonce() {
    assert_eq!(
        frame::parse(
            &serde_json::json!({"type": "CommandStarted", "nonce": "n1"}),
            Some("n1")
        ),
        Ok(Frame::CommandStarted {
            nonce: Some("n1".into())
        })
    );
}

#[test]
fn command_frames_without_the_session_nonce_are_rejected() {
    for kind in ["CommandStarted", "CommandFinished"] {
        for payload in [
            serde_json::json!({"type": kind}),
            serde_json::json!({"type": kind, "nonce": "other"}),
        ] {
            assert_eq!(frame::parse(&payload, Some("n1")), Err(frame::ParseError));
        }
    }
}

#[test]
fn command_finished_keeps_its_nonce_and_exit_code() {
    assert_eq!(
        frame::parse(
            &serde_json::json!({"type": "CommandFinished", "nonce": "n1", "exit_code": 2}),
            Some("n1")
        ),
        Ok(Frame::CommandFinished {
            nonce: Some("n1".into()),
            exit_code: Some(2)
        })
    );
}

#[test]
fn completion_frame_carries_its_validity_fields() {
    let payload = serde_json::json!({
        "type": "Completion", "session_id": "s1", "nonce": "n1", "request_id": "r1",
        "buffer_revision": 3, "cursor": 4, "prompt_generation": 7, "cwd": "/repo",
        "output": "status\nstash"
    });
    assert_eq!(
        frame::parse(&payload, Some("n1")),
        Ok(Frame::Completion(frame::CompletionResult {
            session_id: "s1".into(),
            nonce: "n1".into(),
            request_id: "r1".into(),
            buffer_revision: 3,
            cursor: 4,
            prompt_generation: 7,
            cwd: "/repo".into(),
            output: "status\nstash".into()
        }))
    );
    for field in [
        "session_id",
        "nonce",
        "request_id",
        "buffer_revision",
        "cursor",
        "prompt_generation",
        "cwd",
        "output",
    ] {
        let mut missing = payload.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(
            frame::parse(&missing, Some("n1")),
            Err(frame::ParseError),
            "missing {field}"
        );
    }
    let mut mismatched = payload;
    mismatched["nonce"] = serde_json::json!("other");
    assert_eq!(
        frame::parse(&mismatched, Some("n1")),
        Err(frame::ParseError)
    );
}

#[test]
fn completion_frame_rejects_a_non_string_output() {
    let payload = serde_json::json!({
        "type": "Completion", "session_id": "s1", "nonce": "n1", "request_id": "r1",
        "buffer_revision": 3, "cursor": 4, "prompt_generation": 7, "cwd": "/repo",
        "output": 5
    });
    assert_eq!(frame::parse(&payload, Some("n1")), Err(frame::ParseError));
}

#[test]
fn negative_prompt_generation_is_rejected() {
    let payload = serde_json::json!({
        "type": "PromptReady", "nonce": "n1", "prompt_generation": -1,
        "line_empty": true, "prompt_suppressed": true, "cwd": "/repo"
    });
    assert_eq!(frame::parse(&payload, Some("n1")), Err(frame::ParseError));
}
