//! SQLite-backed annotation store implementing [`AnnotationStore`].
//!
//! Schema mirrors agentation's `mcp/src/server/sqlite.ts` (sessions,
//! annotations, events tables + indexes). Uses `Mutex<Connection>` as
//! managed state per the issue spec. WAL journal for concurrent reads.

use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use tokio::sync::broadcast;

use super::types::*;

// ---------------------------------------------------------------------------
// Event bus — replaces agentation's events.ts EventBus with tokio broadcast
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<AFSEvent>,
    seq: Arc<std::sync::atomic::AtomicI64>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity);
        Self { tx, seq: Arc::new(std::sync::atomic::AtomicI64::new(0)) }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AFSEvent> {
        self.tx.subscribe()
    }

    pub fn emit(&self, ty: AFSEventType, sid: &str, payload: serde_json::Value) -> AFSEvent {
        let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let ev = AFSEvent {
            event_type: ty,
            timestamp: chrono::Utc::now().to_rfc3339(),
            session_id: sid.to_string(),
            sequence: n,
            payload,
        };
        let _ = self.tx.send(ev.clone());
        ev
    }

    pub fn restore_sequence(&self, n: i64) {
        self.seq.store(n, std::sync::atomic::Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

pub struct SqliteStore {
    db: Mutex<Connection>,
    bus: EventBus,
}

impl SqliteStore {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(|e| format!("SQLite open: {e}"))?;
        db.pragma_update(None, "journal_mode", "WAL").map_err(|e| format!("WAL: {e}"))?;
        Self::init(&db)?;
        let bus = EventBus::new(256);
        if let Ok(seq) = db.query_row("SELECT MAX(sequence) FROM events", [], |r| r.get::<_, i64>(0)) {
            if seq > 0 { bus.restore_sequence(seq); }
        }
        Ok(Self { db: Mutex::new(db), bus })
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let db = Connection::open_in_memory().map_err(|e| format!("SQLite in-mem: {e}"))?;
        Self::init(&db)?;
        Ok(Self { db: Mutex::new(db), bus: EventBus::new(64) })
    }

    pub fn event_bus(&self) -> &EventBus { &self.bus }

    fn init(db: &Connection) -> Result<(), String> {
        db.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
                updated_at TEXT, project_id TEXT, metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                x REAL NOT NULL, y REAL NOT NULL,
                comment TEXT NOT NULL, element TEXT NOT NULL, element_path TEXT NOT NULL,
                timestamp INTEGER NOT NULL, selected_text TEXT, bounding_box TEXT,
                nearby_text TEXT, css_classes TEXT, nearby_elements TEXT,
                computed_styles TEXT, full_path TEXT, accessibility TEXT,
                is_multi_select INTEGER DEFAULT 0, is_fixed INTEGER DEFAULT 0,
                react_components TEXT, url TEXT, intent TEXT, severity TEXT,
                status TEXT DEFAULT 'pending', thread TEXT,
                created_at TEXT NOT NULL, updated_at TEXT,
                resolved_at TEXT, resolved_by TEXT, author_id TEXT,
                kind TEXT DEFAULT 'feedback', extra TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL, timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL, sequence INTEGER NOT NULL UNIQUE,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ann_session ON annotations(session_id);
            CREATE INDEX IF NOT EXISTS idx_evt_session_seq ON events(session_id, sequence);"#,
        ).map_err(|e| format!("Schema init: {e}"))?;
        Ok(())
    }

    fn persist_event(&self, ev: &AFSEvent) {
        let db = match self.db.lock() {
            Ok(d) => d,
            Err(e) => { log::error!("[Agentation] persist_event lock failed: {e}"); return; }
        };
        let payload = serde_json::to_string(&ev.payload).unwrap_or_default();
        if let Err(e) = db.execute(
            "INSERT INTO events (type,timestamp,session_id,sequence,payload) VALUES (?,?,?,?,?)",
            params![ev.event_type.as_str(), ev.timestamp, ev.session_id, ev.sequence, payload],
        ) {
            log::error!("[Agentation] persist_event insert failed: {e}");
        }
    }

    fn next_seq(&self) -> i64 {
        self.bus.seq.load(std::sync::atomic::Ordering::SeqCst) + 1
    }

    // --- row mappers ---

    fn row_session(r: &rusqlite::Row) -> rusqlite::Result<Session> {
        Ok(Session {
            id: r.get("id")?, url: r.get("url")?,
            status: parse_session_status(&r.get::<_, String>("status")?),
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at").unwrap_or(None),
            project_id: r.get("project_id").unwrap_or(None),
        })
    }

    fn row_annotation(r: &rusqlite::Row) -> rusqlite::Result<Annotation> {
        let bbox: Option<String> = r.get("bounding_box").unwrap_or(None);
        let thread: Option<String> = r.get("thread").unwrap_or(None);
        let extra: Option<String> = r.get("extra").unwrap_or(None);
        let (placement, rearrange) = extra
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .map(|v| (
                v.get("placement").and_then(|p| serde_json::from_value(p.clone()).ok()),
                v.get("rearrange").and_then(|p| serde_json::from_value(p.clone()).ok()),
            )).unwrap_or((None, None));

        let status_str: String = r.get("status").unwrap_or_else(|_| "pending".into());
        let kind_str: String = r.get("kind").unwrap_or_else(|_| "feedback".into());

        Ok(Annotation {
            id: r.get("id")?, session_id: r.get("session_id")?,
            x: r.get("x")?, y: r.get("y")?,
            comment: r.get("comment")?, element: r.get("element")?,
            element_path: r.get("element_path")?, timestamp: r.get("timestamp")?,
            selected_text: r.get("selected_text").unwrap_or(None),
            bounding_box: bbox.and_then(|s| serde_json::from_str(&s).ok()),
            nearby_text: r.get("nearby_text").unwrap_or(None),
            css_classes: r.get("css_classes").unwrap_or(None),
            nearby_elements: r.get("nearby_elements").unwrap_or(None),
            computed_styles: r.get("computed_styles").unwrap_or(None),
            full_path: r.get("full_path").unwrap_or(None),
            accessibility: r.get("accessibility").unwrap_or(None),
            is_multi_select: r.get::<_, i64>("is_multi_select").ok().map(|v| v != 0),
            is_fixed: r.get::<_, i64>("is_fixed").ok().map(|v| v != 0),
            react_components: r.get("react_components").unwrap_or(None),
            kind: parse_kind(&kind_str),
            placement, rearrange,
            url: r.get("url").unwrap_or(None),
            intent: r.get::<_, Option<String>>("intent").unwrap_or(None).as_deref().and_then(parse_intent),
            severity: r.get::<_, Option<String>>("severity").unwrap_or(None).as_deref().and_then(parse_severity),
            status: parse_status(&status_str),
            thread: thread.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at").unwrap_or(None),
            resolved_at: r.get("resolved_at").unwrap_or(None),
            resolved_by: r.get("resolved_by").unwrap_or(None),
            author_id: r.get("author_id").unwrap_or(None),
        })
    }
}

// --- enum parse helpers ---

fn parse_status(s: &str) -> AnnotationStatus {
    match s {
        "acknowledged" => AnnotationStatus::Acknowledged,
        "resolved" => AnnotationStatus::Resolved,
        "dismissed" => AnnotationStatus::Dismissed,
        _ => AnnotationStatus::Pending,
    }
}

fn parse_session_status(s: &str) -> SessionStatus {
    match s {
        "approved" => SessionStatus::Approved,
        "closed" => SessionStatus::Closed,
        _ => SessionStatus::Active,
    }
}

fn parse_kind(s: &str) -> AnnotationKind {
    match s {
        "placement" => AnnotationKind::Placement,
        "rearrange" => AnnotationKind::Rearrange,
        _ => AnnotationKind::Feedback,
    }
}

fn parse_intent(s: &str) -> Option<AnnotationIntent> {
    match s {
        "fix" => Some(AnnotationIntent::Fix),
        "change" => Some(AnnotationIntent::Change),
        "question" => Some(AnnotationIntent::Question),
        "approve" => Some(AnnotationIntent::Approve),
        _ => None,
    }
}

fn parse_severity(s: &str) -> Option<AnnotationSeverity> {
    match s {
        "blocking" => Some(AnnotationSeverity::Blocking),
        "important" => Some(AnnotationSeverity::Important),
        "suggestion" => Some(AnnotationSeverity::Suggestion),
        _ => None,
    }
}

fn role_str(r: &ThreadRole) -> &'static str {
    match r { ThreadRole::Human => "human", ThreadRole::Agent => "agent" }
}

// ---------------------------------------------------------------------------
// AnnotationStore impl
// ---------------------------------------------------------------------------

impl AnnotationStore for SqliteStore {
    fn create_session(&self, url: &str, project_id: Option<&str>) -> Session {
        let session = Session {
            id: generate_id(),
            url: url.to_string(),
            status: SessionStatus::Active,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: None,
            project_id: project_id.map(String::from),
        };
        {
            let db = match self.db.lock() {
                Ok(d) => d,
                Err(e) => {
                    log::error!("[Agentation] create_session lock failed: {e}");
                    return session;
                }
            };
            if let Err(e) = db.execute(
                "INSERT INTO sessions (id,url,status,created_at,project_id,metadata) VALUES (?,?,?,?,?,NULL)",
                params![session.id, session.url, "active", session.created_at, session.project_id],
            ) {
                log::error!("[Agentation] create_session insert failed: {e}");
            }
        }
        let ev = self.bus.emit(AFSEventType::SessionCreated, &session.id, serde_json::to_value(&session).unwrap());
        self.persist_event(&ev);
        session
    }

    fn get_session_with_annotations(&self, id: &str) -> Option<SessionWithAnnotations> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let session = db.query_row("SELECT * FROM sessions WHERE id=?", params![id], Self::row_session).ok()?;
        let mut stmt = db.prepare("SELECT * FROM annotations WHERE session_id=? ORDER BY timestamp").ok()?;
        let annotations = stmt.query_map(params![id], Self::row_annotation).ok()?
            .filter_map(|r| r.ok()).collect();
        Some(SessionWithAnnotations { session, annotations })
    }

    fn get_session(&self, id: &str) -> Option<Session> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.query_row("SELECT * FROM sessions WHERE id=?", params![id], Self::row_session).ok()
    }

    fn update_session_status(&self, id: &str, status: SessionStatus) -> Option<Session> {
        let now = chrono::Utc::now().to_rfc3339();
        let status_str = match status { SessionStatus::Active => "active", SessionStatus::Approved => "approved", SessionStatus::Closed => "closed" };
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let n = db.execute("UPDATE sessions SET status=?, updated_at=? WHERE id=?", params![status_str, now, id]).ok()?;
            if n == 0 { return None; }
        }
        let session = self.get_session(id)?;
        let ty = if status == SessionStatus::Closed { AFSEventType::SessionClosed } else { AFSEventType::SessionUpdated };
        let ev = self.bus.emit(ty, id, serde_json::to_value(&session).unwrap());
        self.persist_event(&ev);
        Some(session)
    }

    fn list_sessions(&self) -> Vec<Session> {
        let db = match self.db.lock() { Ok(d) => d, Err(_) => return vec![] };
        let mut stmt = match db.prepare("SELECT * FROM sessions ORDER BY created_at DESC") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map([], Self::row_session)
            .map(|iter| iter.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    fn add_annotation(&self, session_id: &str, data: &AnnotationInput) -> Option<Annotation> {
        // Verify session exists
        if self.get_session(session_id).is_none() { return None; }

        let now = chrono::Utc::now().to_rfc3339();
        let id = generate_id();
        let kind = data.kind.clone().unwrap_or_default();
        let kind_str = match kind { AnnotationKind::Placement => "placement", AnnotationKind::Rearrange => "rearrange", _ => "feedback" };

        let extra = if data.placement.is_some() {
            serde_json::to_string(&serde_json::json!({"placement": data.placement})).ok()
        } else if data.rearrange.is_some() {
            serde_json::to_string(&serde_json::json!({"rearrange": data.rearrange})).ok()
        } else { None };

        let bbox_str = data.bounding_box.as_ref().and_then(|b| serde_json::to_string(b).ok());
        let thread_str = data.thread.as_ref().and_then(|t| serde_json::to_string(t).ok());

        let ann = Annotation {
            id: id.clone(), session_id: session_id.to_string(),
            x: data.x, y: data.y,
            comment: data.comment.clone(), element: data.element.clone(), element_path: data.element_path.clone(),
            timestamp: data.timestamp,
            selected_text: data.selected_text.clone(), bounding_box: data.bounding_box.clone(),
            nearby_text: data.nearby_text.clone(), css_classes: data.css_classes.clone(),
            nearby_elements: data.nearby_elements.clone(), computed_styles: data.computed_styles.clone(),
            full_path: data.full_path.clone(), accessibility: data.accessibility.clone(),
            is_multi_select: data.is_multi_select, is_fixed: data.is_fixed,
            react_components: data.react_components.clone(),
            kind: kind.clone(), placement: data.placement.clone(), rearrange: data.rearrange.clone(),
            url: data.url.clone(), intent: data.intent.clone(), severity: data.severity.clone(),
            status: AnnotationStatus::Pending, thread: data.thread.clone(),
            created_at: now.clone(), updated_at: None, resolved_at: None, resolved_by: None,
            author_id: data.author_id.clone(),
        };

        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                r#"INSERT INTO annotations (
                    id,session_id,x,y,comment,element,element_path,timestamp,
                    selected_text,bounding_box,nearby_text,css_classes,nearby_elements,
                    computed_styles,full_path,accessibility,is_multi_select,is_fixed,
                    react_components,url,intent,severity,status,thread,
                    created_at,updated_at,resolved_at,resolved_by,author_id,kind,extra
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "#,
                params![
                    ann.id, ann.session_id, ann.x, ann.y, ann.comment, ann.element, ann.element_path, ann.timestamp,
                    ann.selected_text, bbox_str, ann.nearby_text, ann.css_classes, ann.nearby_elements,
                    ann.computed_styles, ann.full_path, ann.accessibility,
                    ann.is_multi_select.unwrap_or(false) as i64, ann.is_fixed.unwrap_or(false) as i64,
                    ann.react_components, ann.url,
                    ann.intent.as_ref().map(|i| format!("{:?}", i).to_lowercase()), ann.severity.as_ref().map(|s| format!("{:?}", s).to_lowercase()),
                    "pending", thread_str,
                    ann.created_at, ann.updated_at, ann.resolved_at, ann.resolved_by, ann.author_id,
                    kind_str, extra,
                ],
            ).map_err(|e| { log::error!("[Agentation] INSERT annotation failed: {e}"); e.to_string() }).ok()?;
        }

        let ev = self.bus.emit(AFSEventType::AnnotationCreated, session_id, serde_json::to_value(&ann).unwrap());
        self.persist_event(&ev);
        Some(ann)
    }

    fn get_annotation(&self, id: &str) -> Option<Annotation> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.query_row("SELECT * FROM annotations WHERE id=?", params![id], Self::row_annotation).ok()
    }

    fn update_annotation(&self, id: &str, data: &AnnotationUpdate) -> Option<Annotation> {
        let existing = self.get_annotation(id)?;
        let now = chrono::Utc::now().to_rfc3339();
        let status_str = data.status.as_ref().map(|s| match s {
            AnnotationStatus::Pending => "pending", AnnotationStatus::Acknowledged => "acknowledged",
            AnnotationStatus::Resolved => "resolved", AnnotationStatus::Dismissed => "dismissed",
        });
        let thread_str = data.thread.as_ref().and_then(|t| serde_json::to_string(t).ok());
        let intent_str = data.intent.as_ref().map(|i| format!("{:?}", i).to_lowercase());
        let severity_str = data.severity.as_ref().map(|s| format!("{:?}", s).to_lowercase());

        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                r#"UPDATE annotations SET
                    comment=COALESCE(?,comment), status=COALESCE(?,status),
                    updated_at=?, resolved_at=COALESCE(?,resolved_at),
                    resolved_by=COALESCE(?,resolved_by), thread=COALESCE(?,thread),
                    intent=COALESCE(?,intent), severity=COALESCE(?,severity)
                    WHERE id=?"#,
                params![
                    data.comment, status_str, now,
                    data.resolved_at, data.resolved_by, thread_str,
                    intent_str, severity_str, id,
                ],
            ).ok()?;
        }
        let updated = self.get_annotation(id)?;
        let ev = self.bus.emit(AFSEventType::AnnotationUpdated, &existing.session_id, serde_json::to_value(&updated).unwrap());
        self.persist_event(&ev);
        Some(updated)
    }

    fn update_annotation_status(&self, id: &str, status: AnnotationStatus, resolved_by: Option<&str>) -> Option<Annotation> {
        let is_resolved = matches!(status, AnnotationStatus::Resolved | AnnotationStatus::Dismissed);
        let now = if is_resolved { Some(chrono::Utc::now().to_rfc3339()) } else { None };
        self.update_annotation(id, &AnnotationUpdate {
            status: Some(status),
            resolved_at: now,
            resolved_by: resolved_by.map(String::from),
            ..Default::default()
        })
    }

    fn add_thread_message(&self, annotation_id: &str, role: ThreadRole, content: &str) -> Option<Annotation> {
        let existing = self.get_annotation(annotation_id)?;
        let msg = ThreadMessage {
            id: generate_id(), role: role.clone(), content: content.to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
        };
        let mut thread = existing.thread.unwrap_or_default();
        thread.push(msg.clone());
        let updated = self.update_annotation(annotation_id, &AnnotationUpdate {
            thread: Some(thread), ..Default::default()
        })?;
        let ev = self.bus.emit(AFSEventType::ThreadMessage, &existing.session_id, serde_json::to_value(&msg).unwrap());
        self.persist_event(&ev);
        Some(updated)
    }

    fn get_pending_annotations(&self, session_id: &str) -> Vec<Annotation> {
        let db = match self.db.lock() { Ok(d) => d, Err(_) => return vec![] };
        let mut stmt = match db.prepare("SELECT * FROM annotations WHERE session_id=? AND status='pending' ORDER BY timestamp") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![session_id], Self::row_annotation)
            .map(|iter| iter.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    fn get_session_annotations(&self, session_id: &str) -> Vec<Annotation> {
        let db = match self.db.lock() { Ok(d) => d, Err(_) => return vec![] };
        let mut stmt = match db.prepare("SELECT * FROM annotations WHERE session_id=? ORDER BY timestamp") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![session_id], Self::row_annotation)
            .map(|iter| iter.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }


    fn delete_annotation(&self, id: &str) -> Option<Annotation> {
        let existing = self.get_annotation(id)?;
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let rows = db.execute("DELETE FROM annotations WHERE id=?", params![id]).ok()?;
            if rows != 1 {
                log::warn!("[Agentation] delete_annotation affected {rows} rows for id={id}");
                return None;
            }
        }
        // Guard released — safe to emit + persist (which re-locks the mutex).
        let ev = self.bus.emit(AFSEventType::AnnotationDeleted, &existing.session_id, serde_json::to_value(&existing).unwrap());
        self.persist_event(&ev);
        Some(existing)
    }

    fn get_events_since(&self, session_id: &str, sequence: i64) -> Vec<AFSEvent> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match db.prepare("SELECT * FROM events WHERE session_id=? AND sequence>? ORDER BY sequence") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![session_id, sequence], |r| {
            let ty_str: String = r.get("type")?;
            let payload_str: String = r.get("payload")?;
            Ok(AFSEvent {
                event_type: parse_event_type(&ty_str),
                timestamp: r.get("timestamp")?,
                session_id: r.get("session_id")?,
                sequence: r.get("sequence")?,
                payload: serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::Null),
            })
        }).map(|iter| iter.filter_map(|r| r.ok()).collect()).unwrap_or_default()
    }

    fn close(&self) {
        // Connection drops automatically; nothing to do for rusqlite.
    }
}

fn parse_event_type(s: &str) -> AFSEventType {
    match s {
        "annotation.created" => AFSEventType::AnnotationCreated,
        "annotation.updated" => AFSEventType::AnnotationUpdated,
        "annotation.deleted" => AFSEventType::AnnotationDeleted,
        "session.created" => AFSEventType::SessionCreated,
        "session.updated" => AFSEventType::SessionUpdated,
        "session.closed" => AFSEventType::SessionClosed,
        "thread.message" => AFSEventType::ThreadMessage,
        "action.requested" => AFSEventType::ActionRequested,
        _ => AFSEventType::AnnotationCreated,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> SqliteStore {
        SqliteStore::open_in_memory().unwrap()
    }

    #[test]
    fn test_create_and_get_session() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        assert_eq!(session.url, "https://example.com");
        assert_eq!(session.status, SessionStatus::Active);
        let got = store.get_session(&session.id).unwrap();
        assert_eq!(got.id, session.id);
    }

    #[test]
    fn test_add_and_get_annotation() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        let input = AnnotationInput {
            x: 10.0, y: 20.0,
            comment: "Fix this button".to_string(),
            element: "button".to_string(),
            element_path: "body > div > button".to_string(),
            timestamp: 1234567890,
            ..Default::default()
        };
        let ann = store.add_annotation(&session.id, &input).unwrap();
        assert_eq!(ann.comment, "Fix this button");
        assert_eq!(ann.status, AnnotationStatus::Pending);
        assert_eq!(ann.session_id, session.id);

        let got = store.get_annotation(&ann.id).unwrap();
        assert_eq!(got.comment, "Fix this button");
    }

    #[test]
    fn test_pending_annotations() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        for i in 0..3 {
            store.add_annotation(&session.id, &AnnotationInput {
                x: 0.0, y: i as f64, comment: format!("Issue {i}"),
                element: "div".to_string(), element_path: "body > div".to_string(),
                timestamp: i, ..Default::default()
            }).unwrap();
        }
        let pending = store.get_pending_annotations(&session.id);
        assert_eq!(pending.len(), 3);
    }

    #[test]
    fn test_update_status() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        let ann = store.add_annotation(&session.id, &AnnotationInput {
            x: 0.0, y: 0.0, comment: "test".to_string(),
            element: "div".to_string(), element_path: "div".to_string(),
            timestamp: 0, ..Default::default()
        }).unwrap();
        let updated = store.update_annotation_status(&ann.id, AnnotationStatus::Resolved, Some("agent")).unwrap();
        assert_eq!(updated.status, AnnotationStatus::Resolved);
        assert_eq!(updated.resolved_by.as_deref(), Some("agent"));
        assert!(updated.resolved_at.is_some());
    }

    #[test]
    fn test_thread_message() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        let ann = store.add_annotation(&session.id, &AnnotationInput {
            x: 0.0, y: 0.0, comment: "test".to_string(),
            element: "div".to_string(), element_path: "div".to_string(),
            timestamp: 0, ..Default::default()
        }).unwrap();
        let updated = store.add_thread_message(&ann.id, ThreadRole::Agent, "Working on it").unwrap();
        assert!(updated.thread.is_some());
        assert_eq!(updated.thread.unwrap().len(), 1);
    }

    #[test]
    fn test_delete_annotation() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        let ann = store.add_annotation(&session.id, &AnnotationInput {
            x: 0.0, y: 0.0, comment: "test".to_string(),
            element: "div".to_string(), element_path: "div".to_string(),
            timestamp: 0, ..Default::default()
        }).unwrap();
        let deleted = store.delete_annotation(&ann.id).unwrap();
        assert_eq!(deleted.id, ann.id);
        assert!(store.get_annotation(&ann.id).is_none());
    }

    #[test]
    fn test_event_bus() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();
        let ev = bus.emit(AFSEventType::AnnotationCreated, "sess1", serde_json::json!({"id":"a1"}));
        assert_eq!(ev.sequence, 1);
        let received = rx.try_recv().unwrap();
        assert_eq!(received.event_type, AFSEventType::AnnotationCreated);
        assert_eq!(received.session_id, "sess1");
    }

    #[test]
    fn test_events_since() {
        let store = test_store();
        let session = store.create_session("https://example.com", None);
        store.add_annotation(&session.id, &AnnotationInput {
            x: 0.0, y: 0.0, comment: "test".to_string(),
            element: "div".to_string(), element_path: "div".to_string(),
            timestamp: 0, ..Default::default()
        }).unwrap();
        let events = store.get_events_since(&session.id, 0);
        assert!(events.len() >= 2); // session.created + annotation.created
    }
}
