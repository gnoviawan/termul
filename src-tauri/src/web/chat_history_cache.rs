//! In-memory chat-history cache for the desktop-hosted web client (Epic-4 bridge).
//!
//! Mirrors [`crate::web::project_registry::ProjectRegistry`]: an `Arc<ChatHistoryCache>`
//! shared between the router (read path: `list_persisted_sessions` /
//! `get_session_payload`) and the `remote_sync_chat_history` command (write path).
//! All mutation is behind a single `parking_lot::Mutex`.
//!
//! The desktop renderer is the source of truth — it pushes its `tauri_store`-mirrored
//! session index + payloads here (via `remote_sync_chat_history`) exactly like it
//! pushes the project list into `ProjectRegistry` (`remote_sync_projects`). The cache
//! is **in-memory only**, scoped to a running server, cleared on `remote_server_stop`,
//! and re-fed on server-start. It is NOT a file store and never reads
//! `termul-data.json` from Rust.
//!
//! On the standalone VPS path this cache is absent (`None`); the web-client fetch
//! path (`get_session_payload`) falls through to `SessionPersistence` once Story 4.3
//! attaches its file-backed store. Until then a VPS without the cache advertises
//! `live_only` history mode.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;

use crate::acp::SessionIndexEntry;

/// Revisioned index snapshot held behind [`ChatHistoryCache::index`]. The
/// monotonic `revision` lets [`ChatHistoryCache::set_index`] reject a delayed
/// older snapshot that would otherwise replace a newer one (CodeRabbit fix:
/// stale-index replacement race between `useAcpHistorySync` and
/// `persistSession`).
#[derive(Default)]
struct IndexState {
    /// Monotonic revision stamped by `set_index`. A push carrying a `revision`
    /// strictly lower than the current one is rejected as stale so an
    /// out-of-order older index cannot supplant a newer snapshot.
    revision: u64,
    /// Renderer-fed session index (the wire `PersistedSessionSummary[]` shape
    /// — Rust [`SessionIndexEntry`] serializes one-to-one). The renderer
    /// always pushes the full index (mirrors `ProjectRegistry::set`); a fresh
    /// `set_index` fully supersedes the prior snapshot.
    sessions: Vec<SessionIndexEntry>,
}

/// In-memory chat-history cache shared by the desktop-hosted web mode.
///
/// `Arc<ChatHistoryCache>` is shared between the router (read path +
/// switch-back reopen) and the `remote_sync_chat_history` command (write path).
/// All mutation is behind a single `parking_lot::Mutex` so a renderer sync and
/// a `list_persisted_sessions` read never race.
#[derive(Default)]
pub struct ChatHistoryCache {
    /// Revisioned renderer-fed session index. The monotonic `revision` (see
    /// [`IndexState`]) lets `set_index` reject a stale older snapshot.
    index: Mutex<IndexState>,
    /// Renderer-fed full transcripts keyed by session id. Opaque `Value`
    /// (`{ metadata, messages }` in the renderer's `SessionPayload` shape) —
    /// Rust stores + forwards it verbatim and never interprets the shape.
    payloads: Mutex<HashMap<String, Value>>,
}

impl ChatHistoryCache {
    /// Create an empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the whole index atomically. Called by `remote_sync_chat_history`
    /// (renderer push) with the desktop's current session summaries. The
    /// renderer is the source of truth — a fresh `set_index` fully supersedes
    /// the prior snapshot (mirrors `ProjectRegistry::set`).
    ///
    /// `revision` is a monotonic counter the renderer stamps on every index
    /// push (`useAcpHistorySync` increments it; the seed in
    /// `RemoteAccessPopover` uses `0`). A push whose `revision` is strictly
    /// lower than the current one returns early (stale — reject) so a delayed
    /// older index cannot replace a newer snapshot.
    ///
    /// Orphan payloads whose session id is no longer in the new index are
    /// pruned from the `payloads` map so the index + payloads never diverge
    /// (and a session dropped from the renderer's index does not leak its
    /// transcript in memory). Mirrors the `delete` semantics.
    ///
    /// Two-phase (deadlock-free): set the index + collect the id set under the
    /// index lock, release, then retain payloads under the payloads lock. The
    /// index + payloads locks are never nested.
    pub fn set_index(&self, revision: u64, sessions: Vec<SessionIndexEntry>) {
        let ids: std::collections::HashSet<String> = {
            let mut g = self.index.lock();
            if revision < g.revision {
                // Stale: an out-of-order older index must not supplant a newer
                // one. Drop it silently — the newer snapshot is retained.
                return;
            }
            g.revision = revision;
            g.sessions = sessions;
            g.sessions.iter().map(|e| e.session_id.clone()).collect()
        };
        // Prune orphan payloads whose session id is no longer in the new index.
        self.payloads.lock().retain(|id, _| ids.contains(id));
    }

    /// Insert or replace a single session payload. Called by
    /// `remote_sync_chat_history` for each visible payload the renderer pushes
    /// (on `persistSession` while the server runs). Large transcripts are pushed
    /// lazily — only sessions the renderer has in memory are seeded; the web
    /// client gets `not_found` for unseeded ids (I/O matrix).
    ///
    /// Index-guarded: the payload is upserted ONLY when `session_id` is in the
    /// CURRENT index, so a late payload cannot resurrect a transcript for a
    /// session a newer index already pruned. No `revision` is needed — the
    /// guard reads the live index state. Two-phase (deadlock-free): read the
    /// id set under the index lock (release), then upsert under the payloads
    /// lock only when present.
    pub fn set_payload(&self, session_id: &str, payload: Value) {
        let in_index: bool = {
            let g = self.index.lock();
            g.sessions.iter().any(|e| e.session_id == session_id)
        };
        if !in_index {
            // Not in the current index — inserting would resurrect a pruned
            // session. Drop it silently.
            return;
        }
        self.payloads.lock().insert(session_id.to_string(), payload);
    }

    /// Snapshot the cached index for `list_persisted_sessions`. Clones the vec
    /// under the lock (the read is short); the caller serializes outside the
    /// lock. Empty vec is a valid success (browser renders an empty sidebar,
    /// waits for `chat_history_changed`).
    #[must_use]
    pub fn list_sessions(&self) -> Vec<SessionIndexEntry> {
        self.index.lock().sessions.clone()
    }

    /// Fetch a cached full transcript for `get_session_payload`. Returns the
    /// opaque `Value` (`{ metadata, messages }`) or `None` when the id is not
    /// in the cache (the web client shows "chat unavailable").
    #[must_use]
    pub fn get_payload(&self, session_id: &str) -> Option<Value> {
        self.payloads.lock().get(session_id).cloned()
    }

    /// Resolve the most-recent resumable session matching `(project_id, cwd)`
    /// for switch-back reopen. Prefers `resume_eligible` sessions, ordered
    /// newest-first by `last_activity_at`. When `agent_namespace` is `Some`,
    /// candidates are additionally filtered to the current agent's stable
    /// namespace (config id or safe fallback) so a switch-back never reopens
    /// a session owned by a different agent namespace. `None` falls back to the
    /// unfiltered lookup (when the namespace cannot be resolved). The caller
    /// (`execute_project_switch`) still gates the reopen on the agent's
    /// `load`/`resume` capability.
    ///
    /// Ties on `last_activity_at` are broken by `created_at`, then `session_id`
    /// (Rust's `max_by_key` returns the last among ties, so an explicit
    /// comparator gives a well-defined newest).
    #[must_use]
    pub fn find_most_recent_for_project(
        &self,
        project_id: &str,
        cwd: &str,
        agent_namespace: Option<&str>,
    ) -> Option<SessionIndexEntry> {
        let g = self.index.lock();
        g.sessions
            .iter()
            // Match the target project + cwd (both must be present + equal) +
            // the current agent's stable namespace when resolvable.
            .filter(|e| {
                e.project_id.as_deref() == Some(project_id)
                    && e.cwd == cwd
                    && e.resume_eligible
                    && agent_namespace.is_none_or(|ns| {
                        e.stable_agent_namespace.as_deref() == Some(ns)
                    })
            })
            .max_by(|a, b| {
                a.last_activity_at
                    .cmp(&b.last_activity_at)
                    .then(a.created_at.cmp(&b.created_at))
                    .then(a.session_id.cmp(&b.session_id))
            })
            .cloned()
    }

    /// Remove a single session's payload + drop it from the index (mirror of
    /// the renderer's `deleteHistorySession`). Idempotent.
    pub fn delete(&self, session_id: &str) {
        self.payloads.lock().remove(session_id);
        let mut g = self.index.lock();
        g.sessions.retain(|e| e.session_id != session_id);
    }

    /// Clear the cache (called on `remote_server_stop` so stale history does
    /// not linger after the server is off — mirrors `ProjectRegistry::clear`).
    /// Idempotent. Resets the revision too so a fresh server session's seed
    /// (revision `0`) is accepted after a stop/start cycle.
    pub fn clear(&self) {
        *self.index.lock() = IndexState::default();
        self.payloads.lock().clear();
    }

    /// Number of sessions currently mirrored (test helper / diagnostics).
    #[must_use]
    pub fn len(&self) -> usize {
        self.index.lock().sessions.len()
    }

    /// `true` when the cache holds no sessions.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::PersistedSessionStatus;

    fn entry(
        session_id: &str,
        project_id: Option<&str>,
        cwd: &str,
        last_activity_at: u64,
        resume_eligible: bool,
    ) -> SessionIndexEntry {
        SessionIndexEntry {
            storage_key: format!("sk-{session_id}"),
            session_id: session_id.to_string(),
            stable_agent_namespace: resume_eligible.then(|| "config:claude".to_string()),
            runtime_agent_id: Some("agent-1".to_string()),
            project_id: project_id.map(str::to_string),
            cwd: cwd.to_string(),
            title: Some(format!("Chat {session_id}")),
            created_at: 1000,
            last_activity_at,
            status: PersistedSessionStatus::Closed,
            message_count: 5,
            tool_count: 0,
            last_seq: 5,
            resume_eligible,
        }
    }

    #[test]
    fn defaults_to_empty() {
        let cache = ChatHistoryCache::new();
        assert!(cache.is_empty());
        assert!(cache.list_sessions().is_empty());
        assert!(cache.get_payload("missing").is_none());
    }

    #[test]
    fn set_index_replaces_atomically() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![
            entry("s-1", Some("p-1"), "/a", 10, true),
            entry("s-2", Some("p-1"), "/a", 20, true),
        ]);
        assert_eq!(cache.len(), 2);
        // A second set fully supersedes the first.
        cache.set_index(0, vec![entry("s-3", Some("p-2"), "/b", 30, true)]);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.list_sessions()[0].session_id, "s-3");
    }

    #[test]
    fn set_index_prunes_orphan_payloads() {
        let cache = ChatHistoryCache::new();
        // Both sessions are in the index, so both payloads are accepted by
        // the index-guard (no resurrection path here).
        cache.set_index(0, vec![
            entry("s-1", Some("p-1"), "/a", 10, true),
            entry("s-2", Some("p-1"), "/a", 20, true),
        ]);
        cache.set_payload("s-1", serde_json::json!({ "messages": [] }));
        cache.set_payload("s-2", serde_json::json!({ "messages": [] }));
        assert!(
            cache.get_payload("s-2").is_some(),
            "s-2 payload accepted while indexed"
        );
        // A newer index drops s-2 → its payload is pruned so the index +
        // payloads never diverge (mirrors `delete` semantics).
        cache.set_index(1, vec![entry("s-1", Some("p-1"), "/a", 10, true)]);
        assert_eq!(cache.len(), 1);
        assert!(cache.get_payload("s-1").is_some(), "retained payload");
        assert!(cache.get_payload("s-2").is_none(), "orphan payload pruned");
    }

    #[test]
    fn set_and_get_payload_round_trips() {
        let cache = ChatHistoryCache::new();
        // Seed the index so the index-guard accepts s-9's payload.
        cache.set_index(0, vec![entry("s-9", Some("p-1"), "/a", 10, true)]);
        let payload = serde_json::json!({ "metadata": { "id": "s-9" }, "messages": [] });
        cache.set_payload("s-9", payload.clone());
        assert_eq!(cache.get_payload("s-9"), Some(payload));
        assert!(cache.get_payload("absent").is_none());
        // Replace works.
        let payload2 = serde_json::json!({ "metadata": { "id": "s-9" }, "messages": [{ "seq": 1 }] });
        cache.set_payload("s-9", payload2.clone());
        assert_eq!(cache.get_payload("s-9"), Some(payload2));
    }

    #[test]
    fn find_most_recent_picks_newest_resume_eligible_match() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![
            entry("old", Some("p-1"), "/a", 100, true),
            entry("new", Some("p-1"), "/a", 500, true),
            entry("other-project", Some("p-2"), "/a", 900, true),
            entry("wrong-cwd", Some("p-1"), "/c", 999, true),
            entry("not-eligible", Some("p-1"), "/a", 999, false),
        ]);
        let found = cache
            .find_most_recent_for_project("p-1", "/a", None)
            .expect("resumable match");
        assert_eq!(found.session_id, "new");
        assert!(found.resume_eligible);
    }

    #[test]
    fn find_most_recent_filters_by_agent_namespace() {
        let cache = ChatHistoryCache::new();
        // Two resumable sessions for the same (project, cwd) but different
        // agent namespaces. Only the one matching the current agent's
        // namespace is a candidate.
        let mut a = entry("s-a", Some("p-1"), "/a", 500, true);
        a.stable_agent_namespace = Some("config:claude".to_string());
        let mut b = entry("s-b", Some("p-1"), "/a", 900, true);
        b.stable_agent_namespace = Some("config:gemini".to_string());
        cache.set_index(0, vec![a, b]);
        // Current agent is claude → only s-a is a candidate (even though s-b
        // is newer).
        let found = cache
            .find_most_recent_for_project("p-1", "/a", Some("config:claude"))
            .expect("namespace-filtered match");
        assert_eq!(found.session_id, "s-a");
        // No namespace filter → newest wins (s-b).
        let found = cache
            .find_most_recent_for_project("p-1", "/a", None)
            .expect("unfiltered match");
        assert_eq!(found.session_id, "s-b");
        // Unknown namespace → no match.
        assert!(cache
            .find_most_recent_for_project("p-1", "/a", Some("config:other"))
            .is_none());
    }

    #[test]
    fn find_most_recent_breaks_ties_by_created_then_session_id() {
        let cache = ChatHistoryCache::new();
        // Tied last_activity_at; tie broken by created_at (then session_id).
        let mut older_created = entry("s-a", Some("p-1"), "/a", 500, true);
        older_created.created_at = 100;
        let mut newer_created = entry("s-b", Some("p-1"), "/a", 500, true);
        newer_created.created_at = 200;
        cache.set_index(0, vec![older_created, newer_created]);
        let found = cache
            .find_most_recent_for_project("p-1", "/a", None)
            .expect("tie-broken match");
        assert_eq!(found.session_id, "s-b", "higher created_at wins the tie");
        // Fully tied (same last_activity_at + created_at) → highest session_id.
        let mut tied_a = entry("s-a", Some("p-1"), "/a", 500, true);
        tied_a.created_at = 100;
        let mut tied_b = entry("s-b", Some("p-1"), "/a", 500, true);
        tied_b.created_at = 100;
        cache.set_index(0, vec![tied_a, tied_b]);
        let found = cache
            .find_most_recent_for_project("p-1", "/a", None)
            .expect("fully-tied match");
        assert_eq!(found.session_id, "s-b", "highest session_id wins full tie");
    }

    #[test]
    fn find_most_recent_none_when_no_resume_eligible() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![entry("s-1", Some("p-1"), "/a", 10, false)]);
        assert!(cache.find_most_recent_for_project("p-1", "/a", None).is_none());
    }

    #[test]
    fn delete_removes_payload_and_index_entry() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![entry("s-1", Some("p-1"), "/a", 10, true)]);
        cache.set_payload("s-1", serde_json::json!({ "messages": [] }));
        cache.delete("s-1");
        assert!(cache.is_empty());
        assert!(cache.get_payload("s-1").is_none());
        // Idempotent.
        cache.delete("s-1");
        assert!(cache.is_empty());
    }

    #[test]
    fn clear_empties_everything() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![entry("s-1", Some("p-1"), "/a", 10, true)]);
        cache.set_payload("s-1", serde_json::json!({ "messages": [] }));
        assert!(!cache.is_empty());
        cache.clear();
        assert!(cache.is_empty());
        assert!(cache.get_payload("s-1").is_none());
        // Clear is idempotent.
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn set_index_rejects_stale_lower_revision() {
        let cache = ChatHistoryCache::new();
        // A newer snapshot lands first (revision 5).
        cache.set_index(5, vec![entry("s-new", Some("p-1"), "/a", 50, true)]);
        // A delayed older index (revision 3) must NOT replace it.
        cache.set_index(3, vec![entry("s-old", Some("p-1"), "/a", 10, true)]);
        assert_eq!(cache.len(), 1, "stale older index ignored");
        assert_eq!(
            cache.list_sessions()[0].session_id,
            "s-new",
            "newer snapshot retained"
        );
        // An equal-or-higher revision supersedes as before.
        cache.set_index(5, vec![entry("s-eq", Some("p-1"), "/a", 60, true)]);
        assert_eq!(cache.list_sessions()[0].session_id, "s-eq", "equal revision replaces");
        cache.set_index(6, vec![entry("s-higher", Some("p-1"), "/a", 70, true)]);
        assert_eq!(
            cache.list_sessions()[0].session_id,
            "s-higher",
            "higher revision replaces"
        );
    }

    #[test]
    fn set_payload_ignored_for_session_not_in_index() {
        let cache = ChatHistoryCache::new();
        // s-1 is indexed + seeded, then pruned by a newer empty index.
        cache.set_index(0, vec![entry("s-1", Some("p-1"), "/a", 10, true)]);
        cache.set_payload("s-1", serde_json::json!({ "messages": [] }));
        assert!(
            cache.get_payload("s-1").is_some(),
            "payload accepted while indexed"
        );
        // A newer index drops s-1 → its payload is pruned.
        cache.set_index(1, vec![]);
        assert!(cache.get_payload("s-1").is_none(), "pruned payload gone");
        // A late payload for the now-pruned session must NOT resurrect it.
        cache.set_payload("s-1", serde_json::json!({ "messages": [{ "seq": 1 }] }));
        assert!(
            cache.get_payload("s-1").is_none(),
            "late payload must not resurrect a pruned session"
        );
    }

    #[test]
    fn set_payload_accepted_for_session_in_index() {
        let cache = ChatHistoryCache::new();
        cache.set_index(0, vec![entry("s-1", Some("p-1"), "/a", 10, true)]);
        let payload = serde_json::json!({ "messages": [{ "seq": 1 }] });
        cache.set_payload("s-1", payload.clone());
        assert_eq!(
            cache.get_payload("s-1"),
            Some(payload),
            "indexed session payload accepted"
        );
        // A session not in the index is still ignored (guard holds).
        cache.set_payload("s-missing", serde_json::json!({ "messages": [] }));
        assert!(
            cache.get_payload("s-missing").is_none(),
            "non-indexed session payload ignored"
        );
    }
}
