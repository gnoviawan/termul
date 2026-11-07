use super::super::{
    SubagentCaps, SubagentEndReason, SubagentSource, SubagentState, SubagentStop,
    SubagentTranscript,
};
use super::*;

fn record(state: SubagentState, stop: Option<SubagentStop>) -> Subagent {
    Subagent {
        id: "child-1".to_string(),
        root_session_id: "chat-1".to_string(),
        parent_id: None,
        dispatch_tool_call_id: "termul-subagent:child-1".to_string(),
        source: SubagentSource::AcpRfd,
        title: "Explore".to_string(),
        description: None,
        role: None,
        prompt: None,
        background: false,
        state,
        started_at: Some(10),
        ended_at: None,
        model: None,
        usage: None,
        output_file: None,
        caps: SubagentCaps {
            stop,
            transcript: SubagentTranscript::Live,
            live_progress: true,
            usage: true,
        },
    }
}

const CANCEL: Option<SubagentStop> = Some(SubagentStop::SessionCancel);

#[test]
fn a_working_subagent_the_agent_lets_stop_gets_a_cancel_for_its_child_session() {
    for state in [SubagentState::Running, SubagentState::RequiresAction] {
        let running = record(state, CANCEL);
        assert_eq!(
            stop_plan(Some(&running)),
            Ok(StopPlan::CancelSession("child-1"))
        );
    }
}

#[test]
fn an_ended_subagent_is_a_no_op_success_whatever_its_caps() {
    for reason in [SubagentEndReason::Cancelled, SubagentEndReason::Completed] {
        for stop in [CANCEL, None] {
            let ended = record(SubagentState::idle(reason), stop);
            assert_eq!(stop_plan(Some(&ended)), Ok(StopPlan::AlreadyEnded));
        }
    }
}

#[test]
fn a_subagent_without_the_cancel_capability_or_unobservable_is_refused() {
    assert_eq!(
        stop_plan(Some(&record(SubagentState::Running, None))),
        Err(StopSubagentError::NotStoppable)
    );
    assert_eq!(
        stop_plan(Some(&record(SubagentState::Unknown, CANCEL))),
        Err(StopSubagentError::NotStoppable)
    );
}

#[test]
fn an_unknown_subagent_is_refused() {
    assert_eq!(stop_plan(None), Err(StopSubagentError::UnknownSubagent));
}
