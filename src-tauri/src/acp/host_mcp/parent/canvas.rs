//! `Canvas` frames: resolve the session's project on every call, apply the
//! kiosk file-tool policy, and hand the call to the canvas router (spine
//! AD-18, AD-21).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::Value;

use super::HostPlanServer;
use crate::acp::host_mcp::canvas::{CanvasError, CanvasErrorCode, CanvasOutcome};
use crate::acp::host_mcp::canvas_budget;
use crate::acp::host_mcp::canvas_policy::{self, CanvasRoute, ProjectFile};
use crate::acp::host_mcp::presence::CallOrigin;
use crate::acp::host_mcp::FrameReply;
use crate::canvas::persistence::{CallFailed, LateAnswer};

/// How long an export with a `path` that timed out may still finish and be
/// written.
pub(super) const LATE_EXPORT_LIMIT: Duration = Duration::from_secs(600);

/// The project a session works in: the router key and the folder exports
/// are written under (the session's working directory).
struct SessionScope {
    project_id: String,
    root: std::path::PathBuf,
}

impl HostPlanServer {
    pub(super) async fn canvas_call(
        &self,
        session_id: &str,
        agent_id: &str,
        tool: Option<String>,
        method: Option<String>,
        params: Option<String>,
    ) -> FrameReply {
        let tool = tool.unwrap_or_else(|| "-".to_string());
        let Some(method) = method else {
            return canvas_failure(&CanvasError::new(
                CanvasErrorCode::UnknownMethod,
                "a canvas frame needs a method",
            ));
        };
        let Some(scope) = self.scope_of(session_id) else {
            log::warn!(
                "[canvas-gateway] {tool} {method} refused: session {} has no project",
                crate::logging::redact_session_id(session_id)
            );
            return canvas_failure(&CanvasError::new(
                CanvasErrorCode::CanvasClosed,
                "this session belongs to no project, so it has no canvas",
            ));
        };
        let project_id = scope.project_id.as_str();
        let params = params.unwrap_or_else(|| "{}".to_string());
        // Params the gateway cannot parse cannot name a file the editor would
        // parse either; they go through for the editor to reject.
        let parsed = serde_json::from_str::<Value>(&params).ok();
        let route = parsed.as_ref().map_or(CanvasRoute::Forward, |parsed| {
            canvas_policy::route(&method, parsed)
        });
        let outcome = match route {
            CanvasRoute::Forward => {
                log::debug!("[canvas-gateway] {tool} {method} for project {project_id}");
                let timeout = self.call_budget(project_id, &method, parsed.as_ref()).await;
                self.canvas
                    .call_within(project_id, &method, params, timeout)
                    .await
            }
            CanvasRoute::HostSave => {
                log::info!("[canvas-gateway] {tool} host save for project {project_id}");
                self.canvas
                    .call(project_id, "host.save", "{}".to_string())
                    .await
            }
            CanvasRoute::ExportTo { path, execute } => {
                self.export_to(&tool, &scope, &path, &execute).await
            }
            CanvasRoute::Refuse(error) => {
                log::info!(
                    "[canvas-gateway] {tool} {method} refused in kiosk for project {project_id}"
                );
                Err(error)
            }
        };
        match outcome {
            Ok(result) => {
                if let Some(parsed) = &parsed {
                    let origin = CallOrigin {
                        session_id,
                        agent_id,
                        project_id,
                    };
                    self.presence
                        .after_call(origin, &tool, &method, parsed, &result);
                }
                FrameReply::ok_with(Value::String(result))
            }
            Err(error) => canvas_failure(&error),
        }
    }

    /// How long `method` may take ([`canvas_budget`]).
    async fn call_budget(
        &self,
        project_id: &str,
        method: &str,
        params: Option<&Value>,
    ) -> Duration {
        canvas_budget::call_budget(
            self.canvas.mounts(),
            project_id,
            method,
            params,
            self.canvas.call_timeout(),
        )
        .await
    }

    /// Export inline, then write the bytes to `path` inside the project. The
    /// path is checked before the editor runs, so a bad one costs no export,
    /// and again at the write. The reply is upstream's export-to-path result
    /// with the relative path. An export that outlasts its wait is still
    /// written when the editor finishes it ([`Self::write_late`]).
    async fn export_to(
        &self,
        tool: &str,
        scope: &SessionScope,
        path: &str,
        execute: &Value,
    ) -> CanvasOutcome {
        let project_id = scope.project_id.as_str();
        let file = canvas_policy::resolve_project_file(&scope.root, path).inspect_err(|_| {
            log::info!("[canvas-gateway] {tool} export path refused for project {project_id}");
        })?;
        let timeout = self
            .call_budget(project_id, "engine.execute", Some(execute))
            .await;
        let claim = self.exports.claim(&file.absolute);
        let result = match self
            .canvas
            .call_keeping_late(project_id, "engine.execute", execute.to_string(), timeout)
            .await
        {
            Ok(result) => result,
            Err(CallFailed {
                error,
                late: Some(late),
            }) => {
                let message = format!(
                    "{}. The export is still running: Termul writes it to `{}` if it finishes \
                     within {} minutes and no newer export to that path starts first",
                    error.message,
                    file.relative,
                    LATE_EXPORT_LIMIT.as_secs() / 60
                );
                self.write_late(tool, scope, path, file, late, claim);
                return Err(CanvasError::new(error.code, message));
            }
            Err(failed) => return Err(failed.error),
        };
        let (reply, bytes) = written_export(&result, &file)?;
        let size = bytes.len();
        let root = scope.root.clone();
        let requested = path.to_string();
        tokio::task::spawn_blocking(move || {
            canvas_policy::write_project_file(&root, &requested, &bytes)
        })
        .await
        .map_err(|error| engine_error(format!("the export write stopped: {error}")))?
        .inspect_err(|_| {
            log::info!("[canvas-gateway] {tool} export write refused for project {project_id}");
        })?;
        log::info!(
            "[canvas-gateway] {tool} wrote export {} ({size} bytes) for project {project_id}",
            file.relative
        );
        Ok(reply.to_string())
    }

    /// Wait for the late answer of an export that timed out and write it to
    /// `path`, unless a newer export to the same file started meanwhile.
    fn write_late(
        &self,
        tool: &str,
        scope: &SessionScope,
        path: &str,
        file: ProjectFile,
        late: LateAnswer,
        claim: ExportClaim,
    ) {
        let tool = tool.to_string();
        let project_id = scope.project_id.clone();
        let root = scope.root.clone();
        let requested = path.to_string();
        tokio::spawn(async move {
            let relative = file.relative.clone();
            let outcome = late.wait(LATE_EXPORT_LIMIT).await;
            let bytes = match outcome.map(|result| written_export(&result?, &file)) {
                Some(Ok((_, bytes))) => bytes,
                Some(Err(error)) => {
                    log::info!(
                        "[canvas-gateway] {tool} late export {relative} for project {project_id} failed: {} ({})",
                        error.code.as_str(),
                        error.message
                    );
                    return;
                }
                None => {
                    log::info!(
                        "[canvas-gateway] {tool} late export {relative} for project {project_id} never finished"
                    );
                    return;
                }
            };
            let size = bytes.len();
            let written = tokio::task::spawn_blocking(move || {
                claim.write_if_newest(|| {
                    canvas_policy::write_project_file(&root, &requested, &bytes)
                })
            })
            .await;
            match written {
                Ok(Some(Ok(_))) => log::info!(
                    "[canvas-gateway] {tool} wrote late export {relative} ({size} bytes) for project {project_id}"
                ),
                Ok(None) => log::info!(
                    "[canvas-gateway] {tool} late export {relative} for project {project_id} dropped: a newer export to it started"
                ),
                Ok(Some(Err(error))) => log::info!(
                    "[canvas-gateway] {tool} late export write {relative} refused for project {project_id}: {}",
                    error.message
                ),
                Err(error) => log::warn!(
                    "[canvas-gateway] {tool} late export write {relative} stopped for project {project_id}: {error}"
                ),
            }
        });
    }

    /// The session's project and working directory, read from the session
    /// registry each time: a cached binding could outlive a project change.
    fn scope_of(&self, session_id: &str) -> Option<SessionScope> {
        let metadata = self.persistence.as_ref()?.metadata(session_id).ok()?;
        let project_id = metadata.project_id.filter(|project| !project.is_empty())?;
        Some(SessionScope {
            project_id,
            root: std::path::PathBuf::from(metadata.cwd),
        })
    }
}

/// The editor's inline export `{format, data, …}` → the bytes, and the reply
/// `{path, bytes, format, …}` without the data.
fn written_export(result: &str, file: &ProjectFile) -> Result<(Value, Vec<u8>), CanvasError> {
    let mut reply: Value = serde_json::from_str(result)
        .map_err(|error| engine_error(format!("the export returned invalid JSON: {error}")))?;
    let fields = reply
        .as_object_mut()
        .ok_or_else(|| engine_error("the export returned no object"))?;
    let data = match fields.remove("data") {
        Some(Value::String(data)) => data,
        _ => return Err(engine_error("the export returned no data")),
    };
    let encoded = data.split_once(',').map_or(data.as_str(), |(_, rest)| rest);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| engine_error(format!("the export returned invalid base64: {error}")))?;
    fields.insert("path".to_string(), Value::String(file.relative.clone()));
    fields.insert("bytes".to_string(), Value::from(bytes.len()));
    Ok((reply, bytes))
}

/// The newest export to each project file, so a late export never replaces
/// a file that a newer export to the same path wrote or is about to write.
#[derive(Default)]
pub(super) struct ExportClaims {
    newest: Mutex<HashMap<PathBuf, u64>>,
    next: AtomicU64,
}

impl ExportClaims {
    /// Make an export to `path` the newest one.
    fn claim(self: &Arc<Self>, path: &Path) -> ExportClaim {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.newest.lock().insert(path.to_path_buf(), id);
        ExportClaim {
            claims: Arc::clone(self),
            path: path.to_path_buf(),
            id,
        }
    }
}

/// One export's claim on its file, released when dropped.
pub(super) struct ExportClaim {
    claims: Arc<ExportClaims>,
    path: PathBuf,
    id: u64,
}

impl ExportClaim {
    /// Run `write` unless a newer export to the same file started. The lock
    /// is held through the write, so none can start in between.
    fn write_if_newest<T>(&self, write: impl FnOnce() -> T) -> Option<T> {
        let newest = self.claims.newest.lock();
        (newest.get(&self.path) == Some(&self.id)).then(write)
    }
}

impl Drop for ExportClaim {
    fn drop(&mut self) {
        let mut newest = self.claims.newest.lock();
        if newest.get(&self.path) == Some(&self.id) {
            newest.remove(&self.path);
        }
    }
}

fn engine_error(message: impl Into<String>) -> CanvasError {
    CanvasError::new(CanvasErrorCode::EngineError, message)
}

fn canvas_failure(error: &CanvasError) -> FrameReply {
    FrameReply::err_code(error.code.as_str(), error.message.clone())
}
