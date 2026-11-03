//! The subagent records of one agent connection, per chat.
//!
//! Keyed by (chat session id, dispatch tool call id). Bounded: past
//! [`MAX_TRACKED`] the oldest settled entry goes first, as in the native
//! child route table (`session/subagents.rs`).

use std::collections::HashMap;

use super::codex_collab::ThreadState;
use super::tools::ToolView;
use super::{log_transition, Subagent, SubagentSource};

const MAX_TRACKED: usize = 1024;
/// Codex agent threads kept per chat.
const MAX_THREADS_PER_CHAT: usize = 1024;

type Key = (String, String);

/// A dispatch tool call: its record and what the host read from its events.
#[derive(Debug, Clone)]
pub(crate) struct DispatchEntry {
    pub record: Subagent,
    /// The tool call fields a tool mapper accumulated (unused for native
    /// subagent sessions).
    pub view: ToolView,
}

#[derive(Debug, Clone)]
pub(crate) enum Tracked {
    Dispatch(Box<DispatchEntry>),
    /// A call that steers existing subagents.
    Control {
        source: SubagentSource,
        subagent_ids: Vec<String>,
    },
}

impl Tracked {
    pub(crate) fn source(&self) -> SubagentSource {
        match self {
            Self::Dispatch(entry) => entry.record.source,
            Self::Control { source, .. } => *source,
        }
    }

    /// Safe to evict first: a control call, or a subagent whose work ended.
    fn settled(&self) -> bool {
        match self {
            Self::Dispatch(entry) => !entry.record.state.is_working(),
            Self::Control { .. } => true,
        }
    }
}

#[derive(Default)]
pub(crate) struct SubagentRecords {
    tracked: HashMap<Key, Tracked>,
    /// Insertion order, for eviction and for a stable order of changes.
    order: Vec<Key>,
    /// Codex agent thread states per chat.
    codex_threads: HashMap<String, HashMap<String, ThreadState>>,
}

fn key(root: &str, call: &str) -> Key {
    (root.to_string(), call.to_string())
}

impl SubagentRecords {
    pub(crate) fn get(&self, root: &str, call: &str) -> Option<&Tracked> {
        self.tracked.get(&key(root, call))
    }

    pub(crate) fn record(&self, root: &str, call: &str) -> Option<&Subagent> {
        match self.get(root, call)? {
            Tracked::Dispatch(entry) => Some(&entry.record),
            Tracked::Control { .. } => None,
        }
    }

    /// Create (with `create`) or update the dispatch `call` of `root`, then
    /// apply `update`. Returns the record when it is new or changed.
    pub(crate) fn upsert(
        &mut self,
        root: &str,
        call: &str,
        create: impl FnOnce() -> DispatchEntry,
        update: impl FnOnce(&mut DispatchEntry),
    ) -> Option<Subagent> {
        let key = key(root, call);
        if let Some(Tracked::Dispatch(entry)) = self.tracked.get_mut(&key) {
            let before = entry.record.clone();
            update(entry);
            if entry.record == before {
                return None;
            }
            log_transition(Some(&before), &entry.record);
            return Some(entry.record.clone());
        }
        let mut entry = create();
        update(&mut entry);
        log_transition(None, &entry.record);
        let record = entry.record.clone();
        self.insert(key, Tracked::Dispatch(Box::new(entry)));
        Some(record)
    }

    /// Record `call` of `root` as a control call naming `subagent_ids`.
    pub(crate) fn set_control(
        &mut self,
        root: &str,
        call: &str,
        source: SubagentSource,
        subagent_ids: Vec<String>,
    ) {
        self.insert(
            key(root, call),
            Tracked::Control {
                source,
                subagent_ids,
            },
        );
    }

    /// The dispatches of `root` from `source`, in the order the host first
    /// saw them.
    pub(crate) fn dispatches<'a>(
        &'a self,
        root: &'a str,
        source: SubagentSource,
    ) -> impl Iterator<Item = &'a DispatchEntry> + 'a {
        self.order
            .iter()
            .filter(move |(chat, _)| chat == root)
            .filter_map(|key| match self.tracked.get(key) {
                Some(Tracked::Dispatch(entry)) => Some(entry.as_ref()),
                _ => None,
            })
            .filter(move |entry| entry.record.source == source)
    }

    /// Apply `update` to every dispatch of `root` from `source`. Returns the
    /// records that changed, in first-seen order.
    pub(crate) fn update_dispatches(
        &mut self,
        root: &str,
        source: SubagentSource,
        mut update: impl FnMut(&mut DispatchEntry),
    ) -> Vec<Subagent> {
        let mut changed = Vec::new();
        for key in self.order.iter().filter(|(chat, _)| chat == root) {
            let Some(Tracked::Dispatch(entry)) = self.tracked.get_mut(key) else {
                continue;
            };
            if entry.record.source != source {
                continue;
            }
            let before = entry.record.clone();
            update(entry);
            if entry.record != before {
                log_transition(Some(&before), &entry.record);
                changed.push(entry.record.clone());
            }
        }
        changed
    }

    pub(crate) fn codex_threads(&self, root: &str) -> Option<&HashMap<String, ThreadState>> {
        self.codex_threads.get(root)
    }

    /// Set the state of Codex agent `thread` in `root`. Returns true when it
    /// changed. A chat past [`MAX_THREADS_PER_CHAT`] ignores new threads.
    pub(crate) fn set_codex_thread(
        &mut self,
        root: &str,
        thread: &str,
        state: ThreadState,
    ) -> bool {
        let threads = self.codex_threads.entry(root.to_string()).or_default();
        let full = threads.len() >= MAX_THREADS_PER_CHAT;
        match threads.get_mut(thread) {
            Some(current) if *current == state => false,
            Some(current) => {
                *current = state;
                true
            }
            None if full => {
                log::warn!(
                    "[acp] Codex agent threads full ({MAX_THREADS_PER_CHAT}) in chat {}; ignored a new thread",
                    crate::logging::redact_session_id(root)
                );
                false
            }
            None => {
                threads.insert(thread.to_string(), state);
                true
            }
        }
    }

    /// Drop everything of `root` (the chat session closed or reloaded).
    pub(crate) fn forget_root(&mut self, root: &str) {
        self.tracked.retain(|(chat, _), _| chat != root);
        self.order.retain(|(chat, _)| chat != root);
        self.codex_threads.remove(root);
    }

    fn insert(&mut self, key: Key, tracked: Tracked) {
        if let Some(slot) = self.tracked.get_mut(&key) {
            *slot = tracked;
            return;
        }
        self.evict_if_full();
        self.order.push(key.clone());
        self.tracked.insert(key, tracked);
    }

    fn evict_if_full(&mut self) {
        if self.tracked.len() < MAX_TRACKED {
            return;
        }
        let victim = self
            .order
            .iter()
            .position(|key| self.tracked.get(key).is_some_and(Tracked::settled))
            .unwrap_or(0);
        let key = self.order.remove(victim);
        self.tracked.remove(&key);
        log::warn!("[acp] subagent records full ({MAX_TRACKED}); dropped the oldest record");
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.tracked.len()
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod registry_tests;
