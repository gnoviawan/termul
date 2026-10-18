//! A real parent with registered sessions and fake renderers, shared by the
//! gateway tests in `bridge` and `child`.

use std::sync::mpsc;
use std::sync::Arc;

use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasError, CanvasHolder, CanvasRouter};
use crate::acp::host_mcp::child::ChildConfig;
use crate::acp::host_mcp::parent::HostPlanServer;
use crate::acp::session_persistence::SessionPersistence;

pub(crate) struct Harness {
    pub(crate) runtime: tokio::runtime::Runtime,
    root: std::path::PathBuf,
    /// Every session's working directory: the folder exports land in.
    pub(crate) cwd: std::path::PathBuf,
    persistence: Arc<SessionPersistence>,
    server: Arc<HostPlanServer>,
}

impl Harness {
    /// A parent with `sessions` (`(session id, project id)`) registered,
    /// bound and in an active turn.
    pub(crate) fn new(sessions: &[(&str, Option<&str>)]) -> (Self, Vec<ChildConfig>) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let root =
            std::env::temp_dir().join(format!("termul-canvas-bridge-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = runtime.block_on(async {
            let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
            for (session_id, project_id) in sessions {
                persistence
                    .register_session(crate::acp::SessionRegistration {
                        session_id: (*session_id).into(),
                        stable_agent_namespace: Some("config:test".into()),
                        runtime_agent_id: Some("agent-1".into()),
                        project_id: project_id.map(str::to_string),
                        cwd: cwd.clone(),
                        ..Default::default()
                    })
                    .await
                    .unwrap();
            }
            persistence
        });
        let server = HostPlanServer::start(vec![], Some(Arc::clone(&persistence)));
        let configs = sessions
            .iter()
            .enumerate()
            .map(|(index, (session_id, _))| {
                let agent_id = format!("agent-{index}");
                let (port, token, provisional) = server.register_session(&agent_id);
                server.bind_session(&token, session_id);
                server.begin_turn(&agent_id, session_id);
                ChildConfig {
                    port,
                    token,
                    session_id: provisional,
                    agent_id,
                }
            })
            .collect();
        (
            Self {
                runtime,
                root,
                cwd,
                persistence,
                server,
            },
            configs,
        )
    }

    pub(crate) fn router(&self) -> Arc<CanvasRouter> {
        self.server.canvas_router()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let persistence = Arc::clone(&self.persistence);
        let _ = self.runtime.block_on(persistence.shutdown());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A renderer that answers each call with `answer(frame)` (`None` = never).
pub(crate) fn mount_renderer(
    router: &Arc<CanvasRouter>,
    holder_id: &'static str,
    project_id: &str,
    mount_seq: u64,
    answer: impl Fn(&CanvasCallFrame) -> Option<Result<String, CanvasError>> + Send + 'static,
) -> mpsc::Receiver<CanvasCallFrame> {
    let (frames_tx, frames_rx) = mpsc::channel::<CanvasCallFrame>();
    let (seen_tx, seen_rx) = mpsc::channel::<CanvasCallFrame>();
    router.mounts().ensure_test_mount(project_id, mount_seq);
    router.mount(
        project_id,
        mount_seq,
        CanvasHolder::new(
            holder_id,
            Arc::new(move |frame| frames_tx.send(frame).is_ok()),
        ),
    );
    let router = Arc::downgrade(router);
    std::thread::spawn(move || {
        for frame in frames_rx {
            let reply = answer(&frame);
            let _ = seen_tx.send(frame.clone());
            if let (Some(outcome), Some(router)) = (reply, router.upgrade()) {
                router.reply(holder_id, frame.call_id, frame.mount_seq, outcome);
            }
        }
    });
    seen_rx
}
