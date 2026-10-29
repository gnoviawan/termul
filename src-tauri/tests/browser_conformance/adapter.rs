//! The runner's only view of the automation host.
//!
//! It stands in for the renderer (opens the webview when the host asks for an
//! agent tab) and exposes one `call` that goes through the same entry point
//! the host MCP parent uses, with the deadline the parent stamps on a frame.
//! Fixtures are loopback pages, which never raise an origin consent ticket.
//! Sensitive actions on them do: every ticket is recorded for the cases to
//! inspect and answered as unattended unless the case scripted an answer.
//! The session's project folder is a temp dir of fake files. Switching the runner to another host API means
//! editing this file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use termul_manager_lib::conformance_support as host;
use termul_manager_lib::web::sink::{AcpEvent, EventSink};
use tokio::sync::mpsc;

const AGENT_ID: &str = "conformance-agent";
const EVENT_AGENT_TAB: &str = "acp:browser_agent_tab";

/// Right-hand pane geometry in logical pixels, like the app's browser pane.
const TAB_BOUNDS: host::BrowserBounds = host::BrowserBounds {
    x: 400.0,
    y: 0.0,
    width: 800.0,
    height: 800.0,
};

#[derive(Debug, Clone)]
pub struct StepError {
    pub code: String,
    pub reason: Option<String>,
    pub message: String,
}

/// The budget the host documents for one run of `action`.
fn action_budget(action: &str) -> Duration {
    use host::budgets::*;
    match action {
        "navigate" => ACTION_NAVIGATE,
        "new_tab" => ACTION_NEW_TAB,
        "back" | "forward" | "reload" => ACTION_HISTORY,
        "click" | "hover" | "scroll" => ACTION_CLICK,
        "fill" | "type" | "press" => ACTION_TEXT,
        "wait" => ACTION_WAIT,
        "select_option" => ACTION_SELECT,
        "drag" => ACTION_DRAG,
        "check" | "uncheck" => ACTION_TOGGLE,
        "list_tabs" | "close_tab" | "switch_tab" => ACTION_INSTANT,
        _ => ACTION_EVAL,
    }
}

struct RendererSink(mpsc::UnboundedSender<AcpEvent>);

impl EventSink for RendererSink {
    fn emit(&self, event: &AcpEvent) {
        let _ = self.0.send(event.clone());
    }
}

/// One raised consent ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub session: String,
    pub action: host::ActionClass,
    pub origin: String,
}

type Answer = Box<dyn Fn(&host::TicketRequest) -> host::TicketOutcome + Send + Sync>;

/// Records every consent ticket. A session's tickets are answered as
/// unattended unless the case installed an answer for it.
#[derive(Default)]
struct Approver {
    raised: Mutex<Vec<Ticket>>,
    answers: Mutex<HashMap<String, Answer>>,
}

impl host::PermissionRequest for Approver {
    fn request(
        &self,
        ticket: host::TicketRequest,
        _wait: Duration,
    ) -> host::PortFuture<'_, host::TicketOutcome> {
        let outcome = self
            .answers
            .lock()
            .unwrap()
            .get(&ticket.session_id)
            .map_or(host::TicketOutcome::Unattended, |answer| answer(&ticket));
        self.raised.lock().unwrap().push(Ticket {
            session: ticket.session_id,
            action: ticket.action,
            origin: ticket.origin.as_str().to_string(),
        });
        Box::pin(async move { outcome })
    }

    fn cancel_session(&self, _session_id: &str) {}
}

/// Which pre-approvals a case writes: the session's project's, or the
/// app-wide ones global-profile tabs honour.
#[derive(Debug, Clone, Copy)]
pub enum Scope {
    Project,
    App,
}

/// The project folder upload cases read from: fake files only.
pub const UPLOAD_FILE: &str = "fixture-upload.txt";
pub const UPLOAD_BODY: &str = "fake upload for the conformance suite
";
pub const SECRET_FILE: &str = ".env";
pub const LINKED_FILE: &str = "linked.txt";
/// Swapped for a link out of the project while its upload awaits consent.
pub const SWAPPED_FILE: &str = "swapped.txt";

struct Project {
    root: tempfile::TempDir,
    _outside: tempfile::TempDir,
    outside_file: PathBuf,
    linked: bool,
}

fn project() -> Project {
    let root = tempfile::tempdir().expect("project dir");
    let outside = tempfile::tempdir().expect("outside dir");
    std::fs::write(root.path().join(UPLOAD_FILE), UPLOAD_BODY).expect("upload file");
    std::fs::write(root.path().join(SWAPPED_FILE), UPLOAD_BODY).expect("swapped file");
    std::fs::write(root.path().join(SECRET_FILE), "FAKE_TOKEN=not-a-real-secret
").expect("secret file");
    let outside_file = outside.path().join("outside.txt");
    std::fs::write(&outside_file, "fake file outside the project
").expect("outside file");
    let linked = symlink(&outside_file, &root.path().join(LINKED_FILE));
    Project {
        root,
        _outside: outside,
        outside_file,
        linked,
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_file(target, link).is_ok()
}

/// The tier the engine declares for each input the cases exercise.
pub struct Tiers {
    pub pointer_click: host::Support,
    pub text: host::Support,
    pub press: host::Support,
    pub pointer_move: host::Support,
    pub wheel: host::Support,
    pub drag: host::Support,
    /// Focusing an element moves native focus to the tab, so the core
    /// never sends a trusted click that would focus one.
    pub focus_moves: bool,
}

pub struct Engine {
    app: AppHandle,
    /// A second engine on the host's tab manager, for input cases that
    /// drive the adapter directly.
    input: Arc<dyn host::BrowserEngine>,
    _policy_root: tempfile::TempDir,
    policy: Arc<host::BrowserPolicyService>,
    tickets: Arc<Approver>,
    project: Project,
    sessions_root: PathBuf,
}

impl Engine {
    pub fn install(app: &AppHandle) -> Self {
        let tabs = Arc::new(host::BrowserTabManager::new(app.clone()));
        tabs.set_agentation_enabled(false);
        let (tx, rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(RendererSink(tx));
        let policy_root = tempfile::tempdir().expect("policy dir");
        let policy = Arc::new(host::BrowserPolicyService::new(
            policy_root.path().to_path_buf(),
            Arc::new(Vec::new),
            Vec::new(),
            Arc::new(host::UnwiredProfileControl),
        ));
        let tickets = Arc::new(Approver::default());
        let project = project();
        let root = project.root.path().to_path_buf();
        host::set_browser_host(host::DesktopBrowserHost::new(
            app.clone(),
            tabs.clone(),
            vec![sink],
            host::HostServices {
                permissions: tickets.clone(),
                policy: policy.clone(),
                // Each case's session is its own project, so the profile
                // mode and pre-approvals one case sets reach no other.
                project_of: Arc::new(|session: &str| session.to_string()),
                root_of: Arc::new(move |_| Some(root.clone())),
            },
        ));
        tauri::async_runtime::spawn(renderer_stand_in(rx));
        let sessions_root = app
            .path()
            .app_data_dir()
            .expect("app data dir")
            .join("browser-sessions");
        Self {
            app: app.clone(),
            input: host::desktop_engine(tabs),
            _policy_root: policy_root,
            policy,
            tickets,
            project,
            sessions_root,
        }
    }

    /// Every ticket `session` raised so far.
    pub fn tickets(&self, session: &str) -> Vec<Ticket> {
        let raised = self.tickets.raised.lock().unwrap();
        raised.iter().filter(|t| t.session == session).cloned().collect()
    }

    /// Set the app's "ask before an agent submits a password" switch.
    pub async fn ask_before_passwords(&self, ask: bool) -> Result<(), String> {
        let current = self.policy.app_policy().await.map_err(|e| format!("{e:?}"))?;
        self.policy
            .apply_app_op(current.revision, host::AppPolicyOp::SetAskBeforePasswordSubmit(ask))
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    /// Run `session`'s agent tabs on per-session ephemeral profiles.
    pub async fn go_ephemeral(&self, session: &str) -> Result<(), String> {
        let current = self.policy.project_policy(session).await.map_err(|e| format!("{e:?}"))?;
        self.policy
            .apply_project_op(session, current.revision, host::ProjectPolicyOp::SetEphemeral(true))
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    /// Pre-approve `action` on `origin` at `scope`.
    pub async fn preapprove(
        &self,
        session: &str,
        scope: Scope,
        action: host::ActionClass,
        origin: &str,
    ) -> Result<(), String> {
        let origin = host::CanonicalOrigin::parse(origin).map_err(|e| format!("{e:?}"))?;
        let applied = match scope {
            Scope::Project => {
                let item = host::ProjectPreapproval::new(action, origin).map_err(|e| format!("{e:?}"))?;
                let current = self.policy.project_policy(session).await.map_err(|e| format!("{e:?}"))?;
                self.policy
                    .apply_project_op(session, current.revision, host::ProjectPolicyOp::AddPreapproval(item))
                    .await
                    .map(|_| ())
            }
            Scope::App => {
                let item = host::AppPreapproval::new(action, origin).map_err(|e| format!("{e:?}"))?;
                let current = self.policy.app_policy().await.map_err(|e| format!("{e:?}"))?;
                self.policy
                    .apply_app_op(current.revision, host::AppPolicyOp::AddPreapproval(item))
                    .await
                    .map(|_| ())
            }
        };
        applied.map_err(|e| format!("{e:?}"))
    }

    /// Allow `session`'s uploads, but first swap [`SWAPPED_FILE`] for a link
    /// to a file outside the project, as a racing process would.
    pub fn swap_upload_while_asking(&self, session: &str) {
        let swapped = self.project.root.path().join(SWAPPED_FILE);
        let outside = self.project.outside_file.clone();
        let answer: Answer = Box::new(move |ticket| {
            if ticket.action == host::ActionClass::Upload {
                let _ = std::fs::remove_file(&swapped);
                symlink(&outside, &swapped);
            }
            host::TicketOutcome::Answered(host::ConsentOption::AllowSession)
        });
        self.tickets.answers.lock().unwrap().insert(session.to_string(), answer);
    }

    /// Whether the outside-the-project symlink could be created here.
    pub fn has_symlink(&self) -> bool {
        self.project.linked
    }

    /// Where the host writes `session`'s downloads.
    pub fn downloads_dir(&self, session: &str) -> PathBuf {
        host::session_dir(&self.sessions_root, session).join("downloads")
    }

    pub fn input(&self) -> &dyn host::BrowserEngine {
        &*self.input
    }

    pub fn tiers(&self) -> Tiers {
        let caps = &self.input.facts().capabilities;
        Tiers {
            pointer_click: caps.get(host::CapabilityId::PointerClick),
            text: self.input.key_support(host::KeyKind::Text),
            press: self.input.key_support(host::KeyKind::Press),
            pointer_move: caps.get(host::CapabilityId::PointerMove),
            wheel: caps.get(host::CapabilityId::Wheel),
            drag: caps.get(host::CapabilityId::Drag),
            focus_moves: self.input.element_focus_moves_tab_focus(),
        }
    }

    /// Give the chat stand-in (the main webview) native and page focus.
    pub fn focus_chat(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        if let Some(main) = self.app.get_webview("main") {
            let _ = main.set_focus();
            let _ = main.eval("document.getElementById('chat').focus()");
        }
    }

    /// One tool call, as the wire reply an agent would read. A reply that
    /// arrives after the action's documented budget is a `timeout`.
    pub async fn call(&self, session: &str, action: &str, args: Value) -> Result<Value, StepError> {
        let call = host::BrowserCall {
            action: action.to_string(),
            args,
            element: None,
        };
        let frame = host::budgets::FRAME_BUDGET;
        let deadline = host::budgets::Deadline::after(frame);
        let started = Instant::now();
        let reply =
            tokio::time::timeout(frame, host::dispatch(session, AGENT_ID, call, deadline)).await;
        let elapsed = started.elapsed();
        match reply {
            Ok(Ok(success)) if elapsed <= action_budget(action) => Ok(success.to_json()),
            Ok(Ok(_)) => Err(over_budget(action, elapsed)),
            Ok(Err(e)) => Err(StepError {
                code: e.code.to_string(),
                reason: e.reason.map(str::to_string),
                message: e.message,
            }),
            Err(_) => Err(over_budget(action, elapsed)),
        }
    }

    pub fn end_session(&self, session: &str) {
        host::session_ended(session);
    }
}

fn over_budget(action: &str, elapsed: Duration) -> StepError {
    StepError {
        code: "timeout".into(),
        reason: Some("over_budget".into()),
        message: format!(
            "{action} answered after {}s, budget {}s",
            elapsed.as_secs(),
            action_budget(action).as_secs()
        ),
    }
}

/// Mounts every agent tab the host asks for through the registry, as the
/// renderer's `browser_tab_create` does.
async fn renderer_stand_in(mut events: mpsc::UnboundedReceiver<AcpEvent>) {
    while let Some(event) = events.recv().await {
        if event.type_ != EVENT_AGENT_TAB || event.payload["action"] != "open" {
            continue;
        }
        tauri::async_runtime::spawn(async move {
            let Some(tab_id) = event.payload["tabId"].as_str() else {
                return;
            };
            let url = event.payload["url"].as_str().unwrap_or("about:blank");
            if let Err(e) = host::create_tab(tab_id, url, TAB_BOUNDS).await {
                eprintln!("conformance: tab create failed: {} {}", e.code, e.message);
            }
        });
    }
}
