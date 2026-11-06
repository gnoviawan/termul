//! WebKitGTK adapter (Linux): isolated-world eval in a named script
//! world, tab event hooks, script dialogs held for the core, file inputs
//! set through the file chooser, and viewport snapshots.

mod chooser;
mod dialogs;
mod eval;
pub mod events;
mod observe;
pub mod input;
mod screenshot;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;

use super::assets::{self, Script};
use super::observe::{parse_console_batches, ConsoleEntry};
use super::events::DialogAnswer;
use super::{
    file_chooser, string_eval, BrowserEngine, CapabilityId, Support, EngineError, EngineErrorKind,
    EngineFacts, EngineFuture, InputMode, Point,
};
use crate::browser_automation::budgets::EVAL_STEP;
use crate::browser_tab_manager::BrowserTabManager;

pub struct WebKitGtkEngine {
    tabs: Arc<BrowserTabManager>,
    facts: EngineFacts,
}

impl WebKitGtkEngine {
    pub fn new(tabs: Arc<BrowserTabManager>) -> Self {
        let mut facts = string_eval::isolated_facts();
        // The console through the page shim, requests through the
        // engine's resource-load signals, which report no resource type.
        facts.capabilities = facts
            .capabilities
            .with(CapabilityId::ConsoleObserve, Support::Synthetic)
            .with(CapabilityId::NetworkObserve, Support::Synthetic);
        facts.traits.network_observe = true;
        Self { tabs, facts }
    }
}

impl BrowserEngine for WebKitGtkEngine {
    fn facts(&self) -> &EngineFacts {
        &self.facts
    }

    fn evaluate<'a>(&'a self, tab: &'a str, script: Script) -> EngineFuture<'a, Value> {
        Box::pin(async move {
            let body = string_eval::call_body(&script);
            let params = string_eval::params_json(&script);
            string_eval::call(&self.tabs, tab, move |platform, done| {
                eval::call(platform, &body, &params, done)
            })
            .await
        })
    }

    fn pointer_click<'a>(
        &'a self,
        _tab: &'a str,
        _at: Point,
        _mode: InputMode,
    ) -> EngineFuture<'a, ()> {
        Box::pin(async { Err(EngineError::new(EngineErrorKind::Unsupported)) })
    }

    fn screenshot<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let webview = self
                .tabs
                .webview(tab)
                .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
            let (tx, rx) = oneshot::channel();
            webview
                .with_webview(move |platform| screenshot::capture(&platform.inner(), tx))
                .map_err(|_| EngineError::new(EngineErrorKind::Dispatch))?;
            match tokio::time::timeout(EVAL_STEP, rx).await {
                Ok(Ok(shot)) => shot.map_err(EngineError::new),
                Ok(Err(_)) => Err(EngineError::new(EngineErrorKind::NoReply)),
                Err(_) => Err(EngineError::new(EngineErrorKind::Timeout)),
            }
        })
    }

    fn pull_console<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<ConsoleEntry>> {
        Box::pin(async move {
            let pulled = self.evaluate(tab, assets::console_pull()).await?;
            Ok(parse_console_batches(&pulled))
        })
    }

    fn answer_dialog<'a>(
        &'a self,
        tab: &'a str,
        id: u64,
        answer: DialogAnswer,
    ) -> EngineFuture<'a, bool> {
        Box::pin(super::dialogs::answer(&self.tabs, tab, id, answer))
    }

    fn set_input_files<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        path: &'a str,
        files: &'a [PathBuf],
    ) -> EngineFuture<'a, ()> {
        // No child frame is reachable here, so no ref names one.
        if frame.is_some() {
            return Box::pin(async { Err(EngineError::new(EngineErrorKind::Unsupported)) });
        }
        Box::pin(file_chooser::set_input_files(&self.tabs, tab, path, files, eval::call))
    }
}
