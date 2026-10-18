//! The runner's only view of the automation host.
//!
//! It stands in for the renderer (opens the webview when the host asks for an
//! agent tab, answers the consent prompt) and exposes one `call` that goes
//! through the same entry point the host MCP parent uses. Switching the runner
//! to another host API means editing this file.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use termul_manager_lib::conformance_support as host;
use termul_manager_lib::web::sink::{AcpEvent, EventSink};
use tokio::sync::mpsc;

const AGENT_ID: &str = "conformance-agent";
const EVENT_AGENT_TAB: &str = "acp:browser_agent_tab";
const EVENT_CONSENT_REQUEST: &str = "acp:browser_consent_request";

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
    pub message: String,
}

impl StepError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

struct RendererSink(mpsc::UnboundedSender<AcpEvent>);

impl EventSink for RendererSink {
    fn emit(&self, event: &AcpEvent) {
        let _ = self.0.send(event.clone());
    }
}

pub struct Engine {
    _tabs: Arc<host::BrowserTabManager>,
}

impl Engine {
    pub fn install(app: &AppHandle) -> Self {
        let tabs = Arc::new(host::BrowserTabManager::new(app.clone()));
        tabs.set_agentation_enabled(false);
        let (tx, rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(RendererSink(tx));
        host::set_browser_host(host::DesktopBrowserHost::new(
            app.clone(),
            tabs.clone(),
            vec![sink],
        ));
        tauri::async_runtime::spawn(renderer_stand_in(rx, tabs.clone()));
        Self { _tabs: tabs }
    }

    pub async fn call(
        &self,
        session: &str,
        action: &str,
        args: Value,
        budget: Duration,
    ) -> Result<Value, StepError> {
        let call = host::BrowserCall {
            action: action.to_string(),
            args,
            element: None,
        };
        match tokio::time::timeout(budget, host::dispatch(session, AGENT_ID, call)).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(e)) => Err(StepError::new(e.code, e.message)),
            Err(_) => Err(StepError::new(
                "timeout",
                format!("{action}: no reply within {}s", budget.as_secs()),
            )),
        }
    }

    pub fn end_session(&self, session: &str) {
        host::session_ended(session);
    }
}

async fn renderer_stand_in(
    mut events: mpsc::UnboundedReceiver<AcpEvent>,
    tabs: Arc<host::BrowserTabManager>,
) {
    while let Some(event) = events.recv().await {
        match event.type_ {
            EVENT_CONSENT_REQUEST => {
                if let Some(id) = event.payload["requestId"].as_str() {
                    host::consent_responded(id, true);
                }
            }
            EVENT_AGENT_TAB if event.payload["action"] == "open" => {
                let tabs = tabs.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(tab_id) = event.payload["tabId"].as_str() else {
                        return;
                    };
                    let url = event.payload["url"].as_str().unwrap_or("about:blank");
                    match tabs.create(tab_id.to_string(), url.to_string(), TAB_BOUNDS).await {
                        Ok(_) => {
                            host::tab_created(tab_id);
                        }
                        Err(e) => eprintln!("conformance: tab create failed: {e}"),
                    }
                });
            }
            _ => {}
        }
    }
}
