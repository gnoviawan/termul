//! rmcp MCP server exposing 9 agentation tools over stdio.
//!
//! Mirrors agentation's `mcp/src/server/mcp.ts` `handleTool` switch (L692):
//!   list_sessions, get_session, get_pending, get_all_pending,
//!   acknowledge, resolve, dismiss, reply, watch_annotations.
//!
//! Unlike agentation (where the MCP server proxies to a separate HTTP server),
//! here the MCP server talks directly to the shared `SqliteStore` — same
//! process, no HTTP round-trip. The HTTP server runs alongside for the
//! toolbar's direct HTTP calls; the MCP server is the agent-facing surface.

use std::sync::Arc;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::service::serve_server;
use rmcp::{tool, tool_router};
use rmcp::schemars;
use serde::{Deserialize, Serialize};

use super::store::SqliteStore;
use super::types::*;
// ---------------------------------------------------------------------------
// Tool input schemas (derive JsonSchema for rmcp auto-generated inputSchema)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct GetSessionInput {
    /// The session ID to get
    pub session_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct GetPendingInput {
    /// The session ID to get pending annotations for
    pub session_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct AcknowledgeInput {
    /// The annotation ID to acknowledge
    pub annotation_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ResolveInput {
    /// The annotation ID to resolve
    pub annotation_id: String,
    /// Optional summary of how it was resolved
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct DismissInput {
    /// The annotation ID to dismiss
    pub annotation_id: String,
    /// Reason for dismissing this annotation
    pub reason: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ReplyInput {
    /// The annotation ID to reply to
    pub annotation_id: String,
    /// The reply message
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct WatchAnnotationsInput {
    /// Optional session ID to filter. If not provided, watches ALL sessions.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Seconds to wait after first annotation before returning batch (default: 10, max: 60)
    #[serde(default)]
    pub batch_window_seconds: Option<u64>,
    /// Max seconds to wait for first annotation (default: 120, max: 300)
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

pub struct AgentationMcpServer {
    store: Arc<SqliteStore>,
}

impl AgentationMcpServer {
    pub fn new(store: Arc<SqliteStore>) -> Self {
        Self { store }
    }

    fn map_annotation_for_mcp(a: &Annotation) -> serde_json::Value {
        let mut val = serde_json::json!({
            "id": a.id,
            "kind": match a.kind {
                AnnotationKind::Feedback => "feedback",
                AnnotationKind::Placement => "placement",
                AnnotationKind::Rearrange => "rearrange",
            },
            "comment": a.comment,
            "element": a.element,
            "elementPath": a.element_path,
            "url": a.url,
            "intent": a.intent.as_ref().map(|i| format!("{:?}", i).to_lowercase()),
            "severity": a.severity.as_ref().map(|s| format!("{:?}", s).to_lowercase()),
            "timestamp": a.timestamp,
            "nearbyText": a.nearby_text,
            "reactComponents": a.react_components,
        });

        // Add placement/rearrange only when applicable
        if matches!(a.kind, AnnotationKind::Placement) {
            if let Some(p) = &a.placement {
                val["placement"] = serde_json::to_value(p).unwrap();
            }
        }
        if matches!(a.kind, AnnotationKind::Rearrange) {
            if let Some(r) = &a.rearrange {
                val["rearrange"] = serde_json::to_value(r).unwrap();
            }
        }
        val
    }
}

// rmcp auto-generates tools/list from #[tool] attributes.
// The #[tool_router] macro generates the ServerHandler dispatch.
#[tool_router(server_handler)]
impl AgentationMcpServer {
    #[tool(
        name = "agentation_list_sessions",
        description = "List all active annotation sessions"
    )]
    async fn list_sessions(&self) -> String {
        let sessions = self.store.list_sessions();
        let mapped: Vec<serde_json::Value> = sessions.iter().map(|s| serde_json::json!({
            "id": s.id, "url": s.url, "status": format!("{:?}", s.status).to_lowercase(),
            "createdAt": s.created_at,
        })).collect();
        serde_json::to_string_pretty(&serde_json::json!({"sessions": mapped})).unwrap()
    }

    #[tool(
        name = "agentation_get_session",
        description = "Get a session with all its annotations"
    )]
    async fn get_session(&self, Parameters(input): Parameters<GetSessionInput>) -> String {
        match self.store.get_session_with_annotations(&input.session_id) {
            Some(s) => serde_json::to_string_pretty(&s).unwrap_or_else(|_| "error".into()),
            None => format!("Session not found: {}", input.session_id),
        }
    }

    #[tool(
        name = "agentation_get_pending",
        description = "Get all pending (unacknowledged) annotations for a session. Annotations have a `kind` field: \"feedback\" (default), \"placement\" (design component placements), or \"rearrange\" (section reorder/resize). Placement and rearrange annotations include structured data."
    )]
    async fn get_pending(&self, Parameters(input): Parameters<GetPendingInput>) -> String {
        let annotations = self.store.get_pending_annotations(&input.session_id);
        let mapped: Vec<_> = annotations.iter().map(Self::map_annotation_for_mcp).collect();
        serde_json::to_string_pretty(&serde_json::json!({
            "count": mapped.len(),
            "annotations": mapped,
        })).unwrap()
    }

    #[tool(
        name = "agentation_get_all_pending",
        description = "Get all pending annotations across ALL sessions. Includes feedback, design placements, and rearrange annotations. Each annotation has a `kind` field."
    )]
    async fn get_all_pending(&self) -> String {
        let sessions = self.store.list_sessions();
        let mut all = Vec::new();
        for s in &sessions {
            for a in self.store.get_pending_annotations(&s.id) {
                all.push(Self::map_annotation_for_mcp(&a));
            }
        }
        serde_json::to_string_pretty(&serde_json::json!({
            "count": all.len(),
            "annotations": all,
        })).unwrap()
    }

    #[tool(
        name = "agentation_acknowledge",
        description = "Mark an annotation as acknowledged. Use this to let the human know you've seen their feedback and will address it."
    )]
    async fn acknowledge(&self, Parameters(input): Parameters<AcknowledgeInput>) -> String {
        match self.store.update_annotation_status(&input.annotation_id, AnnotationStatus::Acknowledged, Some("agent")) {
            Some(_) => serde_json::to_string_pretty(&serde_json::json!({"acknowledged": true, "annotationId": input.annotation_id})).unwrap(),
            None => format!("Annotation not found: {}", input.annotation_id),
        }
    }

    #[tool(
        name = "agentation_resolve",
        description = "Mark an annotation as resolved. Use this after you've addressed the feedback. Optionally include a summary of what you did."
    )]
    async fn resolve(&self, Parameters(input): Parameters<ResolveInput>) -> String {
        match self.store.update_annotation_status(&input.annotation_id, AnnotationStatus::Resolved, Some("agent")) {
            Some(_) => {
                if let Some(summary) = &input.summary {
                    self.store.add_thread_message(
                        &input.annotation_id, ThreadRole::Agent,
                        &format!("Resolved: {summary}"),
                    );
                }
                serde_json::to_string_pretty(&serde_json::json!({"resolved": true, "annotationId": input.annotation_id, "summary": input.summary})).unwrap()
            }
            None => format!("Annotation not found: {}", input.annotation_id),
        }
    }

    #[tool(
        name = "agentation_dismiss",
        description = "Dismiss an annotation. Use this when you've decided not to address the feedback, with a reason why."
    )]
    async fn dismiss(&self, Parameters(input): Parameters<DismissInput>) -> String {
        match self.store.update_annotation_status(&input.annotation_id, AnnotationStatus::Dismissed, Some("agent")) {
            Some(_) => {
                self.store.add_thread_message(
                    &input.annotation_id, ThreadRole::Agent,
                    &format!("Dismissed: {}", input.reason),
                );
                serde_json::to_string_pretty(&serde_json::json!({"dismissed": true, "annotationId": input.annotation_id, "reason": input.reason})).unwrap()
            }
            None => format!("Annotation not found: {}", input.annotation_id),
        }
    }

    #[tool(
        name = "agentation_reply",
        description = "Add a reply to an annotation's thread. Use this to ask clarifying questions or provide updates to the human."
    )]
    async fn reply(&self, Parameters(input): Parameters<ReplyInput>) -> String {
        match self.store.add_thread_message(&input.annotation_id, ThreadRole::Agent, &input.message) {
            Some(_) => serde_json::to_string_pretty(&serde_json::json!({"replied": true, "annotationId": input.annotation_id, "message": input.message})).unwrap(),
            None => format!("Annotation not found: {}", input.annotation_id),
        }
    }

    #[tool(
        name = "agentation_watch_annotations",
        description = "Block until new annotations appear, then collect a batch and return them. Triggers automatically when annotations are created — the user just annotates in the browser and the agent picks them up. Includes all annotation kinds: feedback, placement (design components), and rearrange (section reorder/resize). After detecting the first new annotation, waits for a batch window to collect more before returning. Use in a loop for hands-free processing. After addressing each annotation, call agentation_resolve with the annotation ID and a summary of what you did. Only resolve annotations the user accepted — if the user rejects your change, leave the annotation open."
    )]
    async fn watch_annotations(&self, Parameters(input): Parameters<WatchAnnotationsInput>) -> String {
        let batch_window = input.batch_window_seconds.unwrap_or(10).min(60).max(1);
        let timeout_secs = input.timeout_seconds.unwrap_or(120).min(300).max(1);

        // Drain: return any pending immediately before blocking on SSE.
        let pending_path = input.session_id.as_deref();
        let pending: Vec<Annotation> = if let Some(sid) = pending_path {
            self.store.get_pending_annotations(sid)
        } else {
            let sessions = self.store.list_sessions();
            let mut all = Vec::new();
            for s in &sessions {
                all.extend(self.store.get_pending_annotations(&s.id));
            }
            all
        };

        if !pending.is_empty() {
            let sessions: std::collections::HashSet<_> = pending.iter().map(|a| a.session_id.clone()).collect();
            let mapped: Vec<_> = pending.iter().map(Self::map_annotation_for_mcp).collect();
            return serde_json::to_string_pretty(&serde_json::json!({
                "timeout": false,
                "count": mapped.len(),
                "sessions": sessions,
                "annotations": mapped,
            })).unwrap();
        }

        // Block on broadcast channel for new annotation.created events
        let mut rx = self.store.event_bus().subscribe();
        let mut collected: Vec<AFSEvent> = Vec::new();
        let mut first = true;
        let mut batch_deadline: Option<tokio::time::Instant> = None;

        let timeout_result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            async {
                loop {
                    let remaining = batch_deadline.map(|d| d.saturating_duration_since(tokio::time::Instant::now()));

                    let ev = if let Some(rem) = remaining {
                        match tokio::time::timeout(rem, rx.recv()).await {
                            Ok(Ok(ev)) => Some(ev),
                            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                                log::warn!("[Agentation] watch_annotations lagged by {n}");
                                continue;
                            }
                            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                            Err(_) => break,
                        }
                    } else {
                        match rx.recv().await {
                            Ok(ev) => Some(ev),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                log::warn!("[Agentation] watch_annotations lagged by {n}");
                                continue;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    };

                    let ev = match ev {
                        Some(ev) => ev,
                        None => break,
                    };

                    if ev.event_type != AFSEventType::AnnotationCreated { continue; }
                    if let Some(sid) = pending_path {
                        if ev.session_id != sid { continue; }
                    }
                    collected.push(ev);
                    if first {
                        first = false;
                        batch_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(batch_window));
                    }
                }
            },
        ).await;

        // Return partial events if any were collected (even on timeout)
        if !collected.is_empty() {
            let sessions: std::collections::HashSet<_> = collected.iter().map(|e| e.session_id.clone()).collect();
            let mapped: Vec<_> = collected.iter()
                .filter_map(|e| serde_json::from_value::<Annotation>(e.payload.clone()).ok())
                .map(|a| Self::map_annotation_for_mcp(&a))
                .collect();
            serde_json::to_string_pretty(&serde_json::json!({
                "timeout": false,
                "count": mapped.len(),
                "sessions": sessions,
                "annotations": mapped,
            })).unwrap()
        } else {
            let _ = timeout_result; // consume to avoid unused warning
            serde_json::to_string_pretty(&serde_json::json!({
                "timeout": true,
                "message": format!("No new annotations within {timeout_secs} seconds"),
            })).unwrap()
        }
    }
}
// ---------------------------------------------------------------------------
// Stdio server entry point
// ---------------------------------------------------------------------------

/// Run the MCP server on stdio. `#[tool_router(server_handler)]` auto-generates
/// the `ServerHandler` impl (including `get_info`) — no manual impl needed,
/// matching the pattern in `acp/host_mcp/child.rs`.
pub async fn serve_stdio(store: Arc<SqliteStore>) -> Result<(), String> {
    let server = AgentationMcpServer::new(store);
    let (stdin, stdout) = rmcp::transport::io::stdio();
    let running = serve_server(server, (stdin, stdout))
        .await
        .map_err(|e| format!("MCP server initialize failed: {e}"))?;
    running
        .waiting()
        .await
        .map_err(|e| format!("MCP server ended with error: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_server() -> AgentationMcpServer {
        AgentationMcpServer::new(Arc::new(SqliteStore::open_in_memory().unwrap()))
    }

    async fn setup_with_annotation() -> (AgentationMcpServer, String, String) {
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let session = store.create_session("https://test.com", None);
        let ann = store.add_annotation(&session.id, &AnnotationInput {
            x: 10.0, y: 20.0, comment: "Fix button".to_string(),
            element: "button".to_string(), element_path: "body > button".to_string(),
            timestamp: 12345, ..Default::default()
        }).unwrap();
        let server = AgentationMcpServer::new(store);
        (server, session.id, ann.id)
    }

    #[tokio::test]
    async fn test_list_sessions() {
        let server = test_server();
        let result = server.list_sessions().await;
        assert!(result.contains("sessions"));
    }

    #[tokio::test]
    async fn test_get_session() {
        let (server, sid, _) = setup_with_annotation().await;
        let result = server.get_session(Parameters(GetSessionInput { session_id: sid.clone() })).await;
        assert!(result.contains(&sid));
    }

    #[tokio::test]
    async fn test_get_pending() {
        let (server, sid, _) = setup_with_annotation().await;
        let result = server.get_pending(Parameters(GetPendingInput { session_id: sid })).await;
        assert!(result.contains("count"));
        assert!(result.contains("1"));
    }

    #[tokio::test]
    async fn test_get_all_pending() {
        let (server, _, _) = setup_with_annotation().await;
        let result = server.get_all_pending().await;
        assert!(result.contains("count"));
        assert!(result.contains("1"));
    }

    #[tokio::test]
    async fn test_acknowledge() {
        let (server, _, aid) = setup_with_annotation().await;
        let result = server.acknowledge(Parameters(AcknowledgeInput { annotation_id: aid })).await;
        assert!(result.contains("acknowledged"));
        assert!(result.contains("true"));
    }

    #[tokio::test]
    async fn test_resolve() {
        let (server, _, aid) = setup_with_annotation().await;
        let result = server.resolve(Parameters(ResolveInput {
            annotation_id: aid,
            summary: Some("Fixed the button color".to_string()),
        })).await;
        assert!(result.contains("resolved"));
        assert!(result.contains("true"));
    }

    #[tokio::test]
    async fn test_dismiss() {
        let (server, _, aid) = setup_with_annotation().await;
        let result = server.dismiss(Parameters(DismissInput {
            annotation_id: aid,
            reason: "Not a real issue".to_string(),
        })).await;
        assert!(result.contains("dismissed"));
        assert!(result.contains("true"));
    }

    #[tokio::test]
    async fn test_reply() {
        let (server, _, aid) = setup_with_annotation().await;
        let result = server.reply(Parameters(ReplyInput {
            annotation_id: aid,
            message: "Looking into this".to_string(),
        })).await;
        assert!(result.contains("replied"));
        assert!(result.contains("true"));
    }

    #[tokio::test]
    async fn test_watch_annotations_drain() {
        let (server, sid, _) = setup_with_annotation().await;
        let result = server.watch_annotations(Parameters(WatchAnnotationsInput {
            session_id: Some(sid),
            batch_window_seconds: Some(1),
            timeout_seconds: Some(2),
        })).await;
        // Should drain pending immediately
        assert!(result.contains("count"));
        assert!(result.contains("1"));
    }
}
