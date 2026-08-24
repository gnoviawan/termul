//! Type definitions for the agentation annotation service.
//!
//! Rust equivalents of agentation's TypeScript types (mcp/src/types.ts).
//! These are the wire-protocol types shared between the HTTP/SSE server,
//! the MCP server, and the SQLite persistence layer.

use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationIntent {
    Fix,
    Change,
    Question,
    Approve,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationSeverity {
    Blocking,
    Important,
    Suggestion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationStatus {
    Pending,
    Acknowledged,
    Resolved,
    Dismissed,
}

impl Default for AnnotationStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Approved,
    Closed,
}

impl Default for SessionStatus {
    fn default() -> Self {
        Self::Active
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Feedback,
    Placement,
    Rearrange,
}

impl Default for AnnotationKind {
    fn default() -> Self {
        Self::Feedback
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThreadRole {
    Human,
    Agent,
}

// -----------------------------------------------------------------------------
// Bounding box
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// -----------------------------------------------------------------------------
// Thread message
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub id: String,
    pub role: ThreadRole,
    pub content: String,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// Placement data (for design component placement annotations)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub component_type: String,
    pub width: f64,
    pub height: f64,
    pub scroll_y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

// -----------------------------------------------------------------------------
// Rearrange data (for section reorder/resize annotations)
// -----------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rearrange {
    pub selector: String,
    pub label: String,
    pub tag_name: String,
    pub original_rect: BoundingBox,
    pub current_rect: BoundingBox,
}

// -----------------------------------------------------------------------------
// Annotation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub session_id: String,
    pub x: f64,
    pub y: f64,
    pub comment: String,
    pub element: String,
    pub element_path: String,
    pub timestamp: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounding_box: Option<BoundingBox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nearby_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css_classes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nearby_elements: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computed_styles: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_multi_select: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_fixed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub react_components: Option<String>,

    pub kind: AnnotationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<Placement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rearrange: Option<Rearrange>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<AnnotationIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<AnnotationSeverity>,
    pub status: AnnotationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<Vec<ThreadMessage>>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub url: String,
    pub status: SessionStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithAnnotations {
    #[serde(flatten)]
    pub session: Session,
    pub annotations: Vec<Annotation>,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AFSEventType {
    AnnotationCreated,
    AnnotationUpdated,
    AnnotationDeleted,
    SessionCreated,
    SessionUpdated,
    SessionClosed,
    ThreadMessage,
    ActionRequested,
}

impl AFSEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AnnotationCreated => "annotation.created",
            Self::AnnotationUpdated => "annotation.updated",
            Self::AnnotationDeleted => "annotation.deleted",
            Self::SessionCreated => "session.created",
            Self::SessionUpdated => "session.updated",
            Self::SessionClosed => "session.closed",
            Self::ThreadMessage => "thread.message",
            Self::ActionRequested => "action.requested",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AFSEvent {
    #[serde(rename = "type")]
    pub event_type: AFSEventType,
    pub timestamp: String,
    pub session_id: String,
    pub sequence: i64,
    pub payload: serde_json::Value,
}

// -----------------------------------------------------------------------------
// Action request
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub session_id: String,
    pub annotations: Vec<Annotation>,
    pub output: String,
    pub timestamp: String,
}

// -----------------------------------------------------------------------------
// Pending response (HTTP + MCP)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingResponse {
    pub count: usize,
    pub annotations: Vec<Annotation>,
}

// -----------------------------------------------------------------------------
// Store trait (hexagonal core port)
// -----------------------------------------------------------------------------

/// Pure-Rust trait defining the annotation persistence contract.
/// The SQLite adapter implements this; the HTTP and MCP servers depend on it.
pub trait AnnotationStore: Send + Sync {
    // Sessions
    fn create_session(&self, url: &str, project_id: Option<&str>) -> Session;
    fn get_session(&self, id: &str) -> Option<Session>;
    fn get_session_with_annotations(&self, id: &str) -> Option<SessionWithAnnotations>;
    fn update_session_status(&self, id: &str, status: SessionStatus) -> Option<Session>;
    fn list_sessions(&self) -> Vec<Session>;

    // Annotations
    fn add_annotation(&self, session_id: &str, data: &AnnotationInput) -> Option<Annotation>;
    fn get_annotation(&self, id: &str) -> Option<Annotation>;
    fn update_annotation(&self, id: &str, data: &AnnotationUpdate) -> Option<Annotation>;
    fn update_annotation_status(
        &self,
        id: &str,
        status: AnnotationStatus,
        resolved_by: Option<&str>,
    ) -> Option<Annotation>;
    fn add_thread_message(
        &self,
        annotation_id: &str,
        role: ThreadRole,
        content: &str,
    ) -> Option<Annotation>;
    fn get_pending_annotations(&self, session_id: &str) -> Vec<Annotation>;
    fn get_session_annotations(&self, session_id: &str) -> Vec<Annotation>;
    fn delete_annotation(&self, id: &str) -> Option<Annotation>;

    // Events
    fn get_events_since(&self, session_id: &str, sequence: i64) -> Vec<AFSEvent>;

    // Lifecycle
    fn close(&self);
}

/// Input for creating a new annotation (server generates id/session_id/status/created_at).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    pub x: f64,
    pub y: f64,
    pub comment: String,
    pub element: String,
    pub element_path: String,
    pub timestamp: i64,

    #[serde(default)]
    pub selected_text: Option<String>,
    #[serde(default)]
    pub bounding_box: Option<BoundingBox>,
    #[serde(default)]
    pub nearby_text: Option<String>,
    #[serde(default)]
    pub css_classes: Option<String>,
    #[serde(default)]
    pub nearby_elements: Option<String>,
    #[serde(default)]
    pub computed_styles: Option<String>,
    #[serde(default)]
    pub full_path: Option<String>,
    #[serde(default)]
    pub accessibility: Option<String>,
    #[serde(default)]
    pub is_multi_select: Option<bool>,
    #[serde(default)]
    pub is_fixed: Option<bool>,
    #[serde(default)]
    pub react_components: Option<String>,

    #[serde(default)]
    pub kind: Option<AnnotationKind>,
    #[serde(default)]
    pub placement: Option<Placement>,
    #[serde(default)]
    pub rearrange: Option<Rearrange>,

    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub intent: Option<AnnotationIntent>,
    #[serde(default)]
    pub severity: Option<AnnotationSeverity>,
    #[serde(default)]
    pub thread: Option<Vec<ThreadMessage>>,
    #[serde(default)]
    pub author_id: Option<String>,
}

/// Partial update for an annotation.
#[derive(Debug, Clone, Default)]
pub struct AnnotationUpdate {
    pub comment: Option<String>,
    pub status: Option<AnnotationStatus>,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    pub thread: Option<Vec<ThreadMessage>>,
    pub intent: Option<AnnotationIntent>,
    pub severity: Option<AnnotationSeverity>,
}

// -----------------------------------------------------------------------------
// ID generation (matches agentation's format: `${Date.now().toString(36)}-${random}`)
// -----------------------------------------------------------------------------

pub fn generate_id() -> String {
    let now = chrono::Utc::now().timestamp_millis();
    // Use getrandom (already a dep) instead of rand crate
    let mut buf = [0u8; 6];
    let _ = getrandom::getrandom(&mut buf);
    let random: String = buf.iter().map(|&c| {
        let v = c % 36;
        if v < 10 { (b'0' + v) as char } else { (b'a' + v - 10) as char }
    }).collect();
    format!("{}-{}", radix36(now), random)
}

fn radix36(n: i64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut result = Vec::new();
    let mut n = n;
    while n > 0 {
        result.push(digits[(n % 36) as usize] as char);
        n /= 36;
    }
    result.reverse();
    result.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id_format() {
        let id = generate_id();
        assert!(id.contains('-'), "ID should contain a dash: {id}");
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert!(!parts[0].is_empty(), "timestamp part should be non-empty");
        assert_eq!(parts[1].len(), 6, "random part should be 6 chars");
    }

    #[test]
    fn test_radix36() {
        assert_eq!(radix36(0), "0");
        assert_eq!(radix36(1), "1");
        assert_eq!(radix36(10), "a");
        assert_eq!(radix36(35), "z");
        assert_eq!(radix36(36), "10");
    }

    #[test]
    fn test_event_type_as_str() {
        assert_eq!(AFSEventType::AnnotationCreated.as_str(), "annotation.created");
        assert_eq!(AFSEventType::SessionClosed.as_str(), "session.closed");
        assert_eq!(AFSEventType::ThreadMessage.as_str(), "thread.message");
    }
}
