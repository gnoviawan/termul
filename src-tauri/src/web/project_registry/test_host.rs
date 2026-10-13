//! A whole host in miniature for the busy / cascade tests: a durable registry
//! over a temp file, an ACP manager over a real session store with a recording
//! sink, a PTY manager and a relay. Shared by the registry, HTTP and `/ws`
//! parity tests.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
use crate::acp::{AcpManager, AgentId, RootCheck};
use crate::pty::manager::SpawnOptions;
use crate::pty::PtyManager;
use crate::web::sink::{AcpEvent, EventSink, WsRelaySink};

use super::{AddProject, ProjectHost, ProjectRegistry};

/// Records every event the ACP manager fans out.
#[derive(Default)]
pub(crate) struct RecordingSink {
    seen: Mutex<Vec<AcpEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

impl RecordingSink {
    /// The `sid` of every recorded event of `type_`, in order.
    pub(crate) fn sids_of(&self, type_: &str) -> Vec<Option<String>> {
        self.seen
            .lock()
            .iter()
            .filter(|event| event.type_ == type_)
            .map(|event| event.sid.clone())
            .collect()
    }
}

pub(crate) struct TestHost {
    pub(crate) registry: Arc<ProjectRegistry>,
    pub(crate) acp: Arc<AcpManager>,
    pub(crate) pty: Arc<PtyManager>,
    pub(crate) relay: Arc<WsRelaySink>,
    pub(crate) sink: Arc<RecordingSink>,
    pub(crate) registry_file: PathBuf,
    /// A directory that exists, for project paths.
    pub(crate) project_dir: PathBuf,
    /// `agent id → live session ids` as the fake drivers see them.
    pub(crate) live: Vec<(AgentId, Arc<Mutex<Vec<String>>>)>,
    _dir: tempfile::TempDir,
}

impl TestHost {
    /// A host whose registry is durable at `<tmp>/projects.json` and whose ACP
    /// manager has one fake agent per distinct agent id in `sessions`
    /// (`(agent, session, project)`), each session registered with its project
    /// in the durable store. `close_works` decides whether agents can close
    /// sessions.
    pub(crate) async fn new(sessions: &[(&str, &str, &str)], close_works: bool) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let project_dir = dir.path().join("project");
        std::fs::create_dir_all(&project_dir).expect("project dir");
        let registry_file = dir.path().join("projects.json");
        let registry = Arc::new(
            ProjectRegistry::open_durable(&registry_file, RootCheck::Strict).expect("open"),
        );

        let persistence = SessionPersistence::open(dir.path().join("store"))
            .await
            .expect("session store");
        for (_, session_id, project_id) in sessions {
            persistence
                .register_session(SessionRegistration {
                    session_id: (*session_id).to_string(),
                    project_id: Some((*project_id).to_string()),
                    cwd: project_dir.clone(),
                    ..Default::default()
                })
                .await
                .expect("register session");
        }
        let sink = Arc::new(RecordingSink::default());
        let acp = Arc::new(AcpManager::with_persistence(
            vec![sink.clone() as Arc<dyn EventSink>],
            persistence,
        ));
        let mut live = Vec::new();
        let mut agents: Vec<&str> = sessions.iter().map(|(agent, _, _)| *agent).collect();
        agents.sort_unstable();
        agents.dedup();
        for agent in agents {
            let ids = sessions
                .iter()
                .filter(|(a, _, _)| *a == agent)
                .map(|(_, session, _)| (*session).to_string())
                .collect();
            let agent_id = AgentId(agent.to_string());
            let set = acp.install_test_agent_with_closable_sessions(
                agent_id.clone(),
                ids,
                close_works,
            );
            live.push((agent_id, set));
        }
        Self {
            registry,
            acp,
            pty: crate::web::test_pty_manager(),
            relay: Arc::new(WsRelaySink::new()),
            sink,
            registry_file,
            project_dir,
            live,
            _dir: dir,
        }
    }

    pub(crate) fn host(&self) -> ProjectHost<'_> {
        ProjectHost {
            registry: &self.registry,
            acp: &self.acp,
            pty: &self.pty,
            relay: &self.relay,
        }
    }

    /// Register `id` at the fixture's project directory.
    pub(crate) async fn add_project(&self, id: &str) {
        self.host()
            .add(AddProject {
                id: id.to_string(),
                name: format!("Project {id}"),
                path: self.project_dir.to_string_lossy().into_owned(),
                color: "blue".to_string(),
                is_archived: false,
            })
            .await
            .expect("add project");
    }

    /// Spawn a real PTY bound to `project_id`; returns its id.
    pub(crate) async fn spawn_terminal(&self, project_id: &str) -> String {
        self.pty
            .spawn(
                SpawnOptions {
                    project_id: Some(project_id.to_string()),
                    ..Default::default()
                },
                None,
            )
            .await
            .expect("spawn terminal")
            .info
            .id
    }

    /// The live session ids of `agent`.
    pub(crate) fn live_sessions(&self, agent: &str) -> Vec<String> {
        self.live
            .iter()
            .find(|(id, _)| id.0 == agent)
            .map(|(_, set)| set.lock().clone())
            .unwrap_or_default()
    }
}
