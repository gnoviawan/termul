//! `Canvas` frames: resolve the session's project on every call, apply the
//! kiosk file-tool policy, and hand the call to the canvas router (spine
//! AD-18, AD-21).

use base64::Engine as _;
use serde_json::Value;

use super::HostPlanServer;
use crate::acp::host_mcp::canvas::{CanvasError, CanvasErrorCode, CanvasOutcome};
use crate::acp::host_mcp::canvas_policy::{self, CanvasRoute, ProjectFile};
use crate::acp::host_mcp::FrameReply;

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
        let route = serde_json::from_str::<Value>(&params).map_or(CanvasRoute::Forward, |parsed| {
            canvas_policy::route(&method, &parsed)
        });
        let outcome = match route {
            CanvasRoute::Forward => {
                log::debug!("[canvas-gateway] {tool} {method} for project {project_id}");
                self.canvas.call(project_id, &method, params).await
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
            Ok(result) => FrameReply::ok_with(Value::String(result)),
            Err(error) => canvas_failure(&error),
        }
    }

    /// Export inline, then write the bytes to `path` inside the project. The
    /// reply is upstream's export-to-path result with the relative path.
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
        let result = self
            .canvas
            .call(project_id, "engine.execute", execute.to_string())
            .await?;
        let (reply, bytes) = written_export(&result, &file)?;
        let size = bytes.len();
        let target = file.absolute.clone();
        tokio::task::spawn_blocking(move || crate::acp::atomic_file::replace(&target, &bytes))
            .await
            .map_err(|error| engine_error(format!("the export write stopped: {error}")))?
            .map_err(|error| {
                engine_error(format!("could not write `{}`: {error}", file.relative))
            })?;
        log::info!(
            "[canvas-gateway] {tool} wrote export {} ({size} bytes) for project {project_id}",
            file.relative
        );
        Ok(reply.to_string())
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

fn engine_error(message: impl Into<String>) -> CanvasError {
    CanvasError::new(CanvasErrorCode::EngineError, message)
}

fn canvas_failure(error: &CanvasError) -> FrameReply {
    FrameReply::err_code(error.code.as_str(), error.message.clone())
}
