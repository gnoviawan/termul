//! Engine-agnostic core: tab registry, consent, verb dispatch, reply
//! shaping and boundary logging. Drives engines only through the
//! [`BrowserEngine`] port; never touches platform crates.

mod actionability;
mod actions;
pub mod authz;
pub mod boundary;
mod consent;
mod dialogs;
pub(crate) mod dispatch;
mod downloads;
mod events;
mod frames;
mod observe;
mod input_actions;
mod page_events;
pub mod ports;
mod profile;
mod reply;
mod sensitive_gate;
pub mod sensitivity;
mod stop;
mod surface;
mod tabs;
mod teardown;
mod uploads;
#[cfg(test)]
pub mod test_support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Url};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

pub use boundary::BrowserError;
pub use dispatch::{expected_args_text, schema, ToolSchema};
pub use reply::{
    Success, ERR_CAPABILITY, ERR_CONFIRMATION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_STALE_REF,
    ERR_TAB_NOT_FOUND, ERR_TIMEOUT,
};
pub use tabs::TabView;
pub use teardown::session_dir;

use super::budgets::Deadline;
use super::engine::events::{DownloadSize, NavPolicy, NavVerdict, TabEvent, TabEvents, TabRole};
use super::engine::{self, BrowserEngine, EngineFacts};
use super::{BrowserCall, BrowserHost, HostFuture, TabCreateError};
use crate::acp::events as acp_events;
use crate::browser_tab_manager::{BrowserBounds, BrowserTabManager};
use crate::web::EventSink;
use authz::HopVerdict;
use consent::ConsentGate;
use events::TabProjection;
use reply::PageData;
use ports::{PermissionRequest, PolicyStore};
use surface::{PaneSurface, TabSurface};
use tabs::{FirstLoad, TabRegistry};

const EVENT_STOP_CHANGED: &str = "acp:browser_stop_changed";

/// The session's host-stamped project id.
pub type ProjectResolver = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// The folder a session works in: the only tree its uploads come from.
pub type RootResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Host services the desktop browser host consumes.
pub struct HostServices {
    pub permissions: Arc<dyn PermissionRequest>,
    /// The project allow-list the gate reads, and where "always allow for
    /// this project" is written.
    pub policy: Arc<dyn PolicyStore>,
    pub project_of: ProjectResolver,
    pub root_of: RootResolver,
}

/// Desktop host: owns the tab registry and drives the pane's webviews
/// through the platform engine adapter and the tab surface.
pub struct DesktopBrowserHost {
    me: Weak<DesktopBrowserHost>,
    surface: Arc<dyn TabSurface>,
    engine: Arc<dyn BrowserEngine>,
    sinks: Vec<Arc<dyn EventSink>>,
    gate: ConsentGate,
    policy: Arc<dyn PolicyStore>,
    project_of: ProjectResolver,
    root_of: RootResolver,
    downloads: downloads::Downloads,
    registry: Arc<Mutex<TabRegistry>>,
    events: UnboundedSender<(String, TabEvent)>,
    nav_policy: Arc<dyn NavPolicy>,
}

impl DesktopBrowserHost {
    pub fn new(
        app: AppHandle,
        tabs: Arc<BrowserTabManager>,
        sinks: Vec<Arc<dyn EventSink>>,
        services: HostServices,
    ) -> Arc<Self> {
        let engine = engine::desktop_engine(tabs.clone());
        let traits = engine.facts().traits;
        log::info!(
            "[browser-agent] engine registered (isolated_world={}, background_render={})",
            traits.isolated_world,
            traits.background_render
        );
        let surface: Arc<dyn TabSurface> = Arc::new(PaneSurface { app, tabs });
        teardown::spawn_startup_sweep(surface.clone());
        Self::with_parts(surface, engine, sinks, services)
    }

    fn with_parts(
        surface: Arc<dyn TabSurface>,
        engine: Arc<dyn BrowserEngine>,
        sinks: Vec<Arc<dyn EventSink>>,
        services: HostServices,
    ) -> Arc<Self> {
        let registry = Arc::new(Mutex::new(TabRegistry::default()));
        let (tx, rx) = unbounded_channel();
        let consumer = (registry.clone(), surface.clone(), sinks.clone());
        let host = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            nav_policy: Arc::new(HopPolicy {
                surface: surface.clone(),
                host: me.clone(),
            }),
            surface,
            engine,
            sinks,
            gate: ConsentGate::new(services.permissions, services.policy.clone()),
            policy: services.policy,
            project_of: services.project_of,
            root_of: services.root_of,
            downloads: downloads::Downloads::default(),
            registry,
            events: tx,
        });
        let (registry, surface, sinks) = consumer;
        spawn(events::consume(rx, registry, surface, sinks, Arc::downgrade(&host)));
        host
    }

    fn emit<T: Serialize>(&self, session_id: Option<&str>, name: &'static str, payload: &T) {
        acp_events::fan_out(&self.sinks, session_id, name, payload);
    }

    fn tab_events(&self, label: &str) -> TabEvents {
        let role = match tabs::parse_label(label) {
            Some(tabs::LabelKind::Agent) => TabRole::Agent,
            _ => TabRole::User,
        };
        TabEvents::new(label, self.events.clone(), self.nav_policy.clone()).with_role(role)
    }

    /// Build the webview for a renderer-requested tab and admit it to the
    /// registry once the engine confirmed it.
    async fn create_tab_inner(
        &self,
        label: &str,
        url: &str,
        bounds: BrowserBounds,
    ) -> Result<TabView, TabCreateError> {
        let first = self
            .registry
            .lock()
            .begin_create(label, url)
            .map_err(|refusal| TabCreateError {
                code: refusal.code(),
                message: refusal.message().to_string(),
            })?;
        let built = match self.data_store(label) {
            Ok(store) => {
                self.surface
                    .create(label, first.build_url(), bounds, self.tab_events(label), store)
                    .await
            }
            Err(message) => Err(message),
        };
        if let Err(message) = built {
            self.registry
                .lock()
                .fail_create(label, "the browser engine did not create the tab");
            return Err(TabCreateError {
                code: "BROWSER_TAB_CREATE_FAILED",
                message,
            });
        }
        if let FirstLoad::ViaBlank(url) = first {
            if let Err(message) = self.surface.navigate(label, url) {
                self.registry
                    .lock()
                    .fail_create(label, "the tab could not load its page");
                self.surface.close(label).await;
                return Err(TabCreateError {
                    code: "BROWSER_TAB_CREATE_FAILED",
                    message,
                });
            }
        }
        let live = self.registry.lock().finish_create(label);
        if !live {
            // Closed while it was being built.
            self.surface.close(label).await;
            return Err(TabCreateError {
                code: "BROWSER_TAB_CLOSED",
                message: "the tab was closed while it was being created".to_string(),
            });
        }
        let (view, session) = {
            let registry = self.registry.lock();
            let session = registry
                .get(label)
                .and_then(|record| record.session_id().map(str::to_string));
            let view = registry.view(label).ok_or_else(|| TabCreateError {
                code: "BROWSER_TAB_CLOSED",
                message: "the tab closed during creation".to_string(),
            })?;
            (view, session)
        };
        let projection = TabProjection::Updated(view.clone());
        events::publish(self.surface.as_ref(), &self.sinks, session.as_deref(), &projection);
        log::info!("[browser-tab] tab {} live", events::label_prefix(label));
        Ok(view)
    }

    async fn destroy_tab_inner(&self, label: &str) {
        let closing = self.registry.lock().begin_close(label);
        if closing {
            self.surface.close(label).await;
        }
    }
}

/// Decides every navigation hop of every tab webview, once, on the UI
/// thread: the host perimeter for any tab, then the session's Stop latch
/// and origin authorization for an agent tab. The verdict is the one the
/// tab's `NavStarting` event reports.
struct HopPolicy {
    surface: Arc<dyn TabSurface>,
    host: Weak<DesktopBrowserHost>,
}

impl NavPolicy for HopPolicy {
    fn decide(&self, tab: &str, url: &Url) -> NavVerdict {
        if page_events::launches_external_app(url) {
            page_events::log_external_launch(tab);
            return NavVerdict::Deny;
        }
        let allowed = self.surface.allows_navigation(tab, url)
            && self.host.upgrade().is_some_and(|host| host.agent_hop_allowed(tab, url));
        if allowed {
            NavVerdict::Allow
        } else {
            NavVerdict::Deny
        }
    }

    fn holds_downloads(&self, tab: &str) -> bool {
        self.host.upgrade().is_some_and(|host| {
            host.registry
                .lock()
                .get(tab)
                .is_some_and(|record| record.session_id().is_some())
        })
    }

    fn download_starting(&self, tab: &str, url: &Url, suggested: &Path) -> Option<PathBuf> {
        self.host.upgrade()?.download_starting(tab, url, suggested)
    }

    fn download_progress(&self, tab: &str, url: &Url, size: DownloadSize) -> bool {
        self.host.upgrade().is_some_and(|host| host.download_progress(tab, url, size))
    }

    fn download_finished(&self, tab: &str, url: &Url, success: bool) {
        if let Some(host) = self.host.upgrade() {
            host.download_finished(tab, url, success);
        }
    }
}

impl DesktopBrowserHost {
    /// Agent authorization for one hop. A user tab has none to pass; a
    /// label the registry no longer knows passes nothing.
    fn agent_hop_allowed(&self, tab_id: &str, url: &Url) -> bool {
        let owner = self
            .registry
            .lock()
            .get(tab_id)
            .map(|record| record.session_id().map(str::to_string));
        let session_id = match owner {
            Some(Some(session_id)) => session_id,
            Some(None) => return true,
            None => {
                log::info!(
                    "[browser-agent] navigation hop cancelled tab={} reason=unknown_tab",
                    events::label_prefix(tab_id)
                );
                return false;
            }
        };
        let tab = events::label_prefix(tab_id);
        if self.gate.is_stopped(&session_id) {
            log::info!("[browser-agent] navigation hop cancelled tab={tab} reason=stopped_by_user");
            return false;
        }
        match self.gate.check_hop(&session_id, url) {
            HopVerdict::Allow => true,
            HopVerdict::Deny(reason) => {
                log::info!("[browser-agent] navigation hop cancelled tab={tab} reason={}", reason.as_str());
                false
            }
            HopVerdict::Ungranted(..) => {
                log::info!("[browser-agent] navigation hop cancelled tab={tab} reason=ungranted_origin");
                false
            }
        }
    }
}

/// Run `fut` on the current tokio runtime when there is one (tests), else
/// on tauri's.
fn spawn<F>(fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(fut);
        }
        Err(_) => {
            tauri::async_runtime::spawn(fut);
        }
    }
}

impl BrowserHost for DesktopBrowserHost {
    fn execute<'a>(
        &'a self,
        session_id: &'a str,
        _agent_id: &'a str,
        call: BrowserCall,
        deadline: Deadline,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Success, BrowserError>> + Send + 'a>>
    {
        Box::pin(async move {
            let token = self.gate.begin(session_id)?;
            let mut call = call;
            let spec = dispatch::admit(&call.action, &mut call.args, self.engine.facts())?;
            if self.registry.lock().is_closing(session_id) {
                return Err(BrowserError::new(ERR_TAB_NOT_FOUND, "this session has ended")
                    .with_reason("session_ended"));
            }
            self.refuse_if_blocked(session_id, spec.verb, &call.args)?;
            token
                .guard(async {
                    self.authorize_call(&token, session_id, spec.verb, &call, deadline)
                        .await?;
                    self.confirm_sensitive_call(&token, session_id, spec.verb, &call, deadline)
                        .await?;
                    // After a consent wait the call may no longer have time to
                    // run the verb: refuse it now rather than act after the
                    // agent gave up.
                    if !deadline.admits(spec.budget) {
                        return Err(BrowserError::new(
                            ERR_TIMEOUT,
                            format!(
                                "not enough time left in this call to run {}; call it again",
                                spec.name
                            ),
                        )
                        .with_reason("deadline"));
                    }
                    let done = self.act_watched(session_id, spec, call, deadline).await;
                    let reads_page = |success: &Success| {
                        spec.verb == dispatch::Verb::Screenshot
                            || success.page.as_ref().is_some_and(PageData::carries_page_text)
                    };
                    if done.as_ref().is_ok_and(reads_page) {
                        self.gate.taint(session_id);
                    }
                    done
                })
                .await
        })
    }

    fn engine_facts(&self) -> EngineFacts {
        self.engine.facts().clone()
    }

    fn end_session(&self, session_id: &str) {
        if let Some(me) = self.me.upgrade() {
            let session_id = session_id.to_string();
            spawn(async move {
                me.teardown_session(&session_id).await;
            });
        }
    }

    fn create_tab<'a>(
        &'a self,
        label: &'a str,
        url: &'a str,
        bounds: BrowserBounds,
    ) -> HostFuture<'a, Result<TabView, TabCreateError>> {
        Box::pin(self.create_tab_inner(label, url, bounds))
    }

    fn destroy_tab<'a>(&'a self, label: &'a str) -> HostFuture<'a, ()> {
        Box::pin(self.destroy_tab_inner(label))
    }

    fn stop(&self, session_id: &str) -> bool {
        let first = self.gate.stop(session_id);
        log::info!(
            "[browser-agent] stopped by user session={}",
            crate::logging::redact_session_id(session_id)
        );
        self.emit(
            Some(session_id),
            EVENT_STOP_CHANGED,
            &json!({ "sessionId": session_id, "stopped": true }),
        );
        if let Some(me) = self.me.upgrade() {
            me.close_popups(session_id);
        }
        first
    }

    fn user_turn(&self, session_id: &str) {
        if self.gate.resume(session_id) {
            self.emit(
                Some(session_id),
                EVENT_STOP_CHANGED,
                &json!({ "sessionId": session_id, "stopped": false }),
            );
        }
    }
}

#[cfg(test)]
mod tests;
