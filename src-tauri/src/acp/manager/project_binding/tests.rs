use std::sync::Arc;

use parking_lot::Mutex;

use super::*;
use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
use crate::web::sink::AcpEvent;
use crate::web::EventSink;

#[derive(Default)]
struct RecordingSink {
    seen: Mutex<Vec<AcpEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

impl RecordingSink {
    fn of_type(&self, type_: &str) -> Vec<Option<String>> {
        self.seen
            .lock()
            .iter()
            .filter(|event| event.type_ == type_)
            .map(|event| event.sid.clone())
            .collect()
    }
}

fn agent(id: &str) -> AgentId {
    AgentId(id.to_string())
}

/// A manager over a real durable store with one registered session per
/// `(session, project)` pair, plus a recording sink.
async fn manager_with_sessions(
    dir: &std::path::Path,
    sessions: &[(&str, &str)],
) -> (AcpManager, Arc<RecordingSink>) {
    let cwd = dir.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(dir.join("store")).await.unwrap();
    for (session_id, project_id) in sessions {
        persistence
            .register_session(SessionRegistration {
                session_id: (*session_id).to_string(),
                project_id: Some((*project_id).to_string()),
                cwd: cwd.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    let sink = Arc::new(RecordingSink::default());
    let acp = AcpManager::with_persistence(vec![sink.clone() as Arc<dyn EventSink>], persistence);
    (acp, sink)
}

#[tokio::test]
async fn lists_only_live_sessions_stamped_with_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let (acp, _sink) = manager_with_sessions(
        dir.path(),
        &[("s-1", "p-1"), ("s-2", "p-2"), ("s-3", "p-1")],
    )
    .await;
    // `s-3` is registered for p-1 but not live on any agent; `s-9` is live but
    // has no persisted project binding (an ephemeral warm-pool session).
    acp.install_test_agent_with_closable_sessions(
        agent("a1"),
        vec!["s-1".into(), "s-2".into(), "s-9".into()],
        true,
    );

    let bound = acp.sessions_bound_to_project("p-1").await;
    assert_eq!(bound, vec![(agent("a1"), "s-1".to_string())]);
    assert!(acp.sessions_bound_to_project("p-none").await.is_empty());
}

#[tokio::test]
async fn stopping_closes_the_sessions_and_keeps_an_agent_with_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let (acp, sink) =
        manager_with_sessions(dir.path(), &[("s-1", "p-1"), ("s-2", "p-2")]).await;
    let live = acp.install_test_agent_with_closable_sessions(
        agent("a1"),
        vec!["s-1".into(), "s-2".into()],
        true,
    );

    acp.stop_project_sessions(&agent("a1"), &["s-1".to_string()])
        .await;

    assert_eq!(*live.lock(), vec!["s-2".to_string()]);
    assert_eq!(
        acp.list_agents(),
        vec![agent("a1")],
        "the agent still serves another project's session"
    );
    assert_eq!(
        sink.of_type(events::EVENT_SESSION_CLOSED),
        vec![Some("s-1".to_string())]
    );
    assert!(sink.of_type(events::EVENT_AGENT_DISCONNECTED).is_empty());
}

#[tokio::test]
async fn stopping_the_last_sessions_kills_the_agent_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let (acp, sink) = manager_with_sessions(dir.path(), &[("s-1", "p-1")]).await;
    acp.install_test_agent_with_closable_sessions(agent("a1"), vec!["s-1".into()], true);

    acp.stop_project_sessions(&agent("a1"), &["s-1".to_string()])
        .await;

    assert!(acp.list_agents().is_empty(), "no other session uses the agent");
    assert_eq!(
        sink.of_type(events::EVENT_SESSION_CLOSED),
        vec![Some("s-1".to_string())]
    );
    assert_eq!(sink.of_type(events::EVENT_AGENT_DISCONNECTED), vec![None]);
}

#[tokio::test]
async fn a_session_that_cannot_close_is_left_alive_when_the_agent_serves_others() {
    let dir = tempfile::tempdir().unwrap();
    let (acp, sink) =
        manager_with_sessions(dir.path(), &[("s-1", "p-1"), ("s-2", "p-2")]).await;
    let live = acp.install_test_agent_with_closable_sessions(
        agent("a1"),
        vec!["s-1".into(), "s-2".into()],
        false,
    );

    acp.stop_project_sessions(&agent("a1"), &["s-1".to_string()])
        .await;

    assert_eq!(live.lock().len(), 2, "nothing was closed");
    assert_eq!(acp.list_agents(), vec![agent("a1")]);
    assert!(sink.of_type(events::EVENT_SESSION_CLOSED).is_empty());
}
