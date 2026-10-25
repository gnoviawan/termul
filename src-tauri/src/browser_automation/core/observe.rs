//! Console and network observations per agent tab: bounded logs filled
//! from tab events (or, for a page-shim console, pulled on read), and the
//! paginated `console` and `network` verbs that read them.
//!
//! Entries are page-derived, so they reach the agent only under the
//! untrusted `page` object and never reach a log line.

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::{json, Value};

use super::dispatch::Verb;
use super::events::label_prefix;
use super::reply::{Fidelity, Success};
use super::{BrowserError, DesktopBrowserHost};
use crate::browser_automation::engine::observe::{ConsoleEntry, NetworkEntry};
use crate::browser_automation::engine::{CapabilityId, Support};

/// Entries kept per tab and kind; older ones are evicted first.
pub const KEEP: usize = 500;
const LIMIT_DEFAULT: usize = 50;
pub const LIMIT_MAX: usize = 200;
/// Serialized entry bytes per reply; a page stops early past this.
pub const PAGE_MAX_BYTES: usize = 32 * 1024;

struct Logged<T> {
    seq: u64,
    epoch: u64,
    entry: T,
}

/// One kind of observation for one tab, in arrival order. `seq` numbers
/// are per log, start at 1 and never repeat, so a cursor survives
/// navigations and eviction.
pub struct ObservedLog<T> {
    entries: VecDeque<Logged<T>>,
    last_seq: u64,
}

impl<T> Default for ObservedLog<T> {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            last_seq: 0,
        }
    }
}

/// One page of a log, after a cursor.
#[derive(Debug, PartialEq)]
pub struct LogPage {
    pub entries: Vec<Value>,
    /// The cursor for the next page.
    pub cursor: u64,
    pub more: bool,
    /// Entries after the cursor that were evicted before this read.
    pub dropped: u64,
}

impl<T: Serialize> ObservedLog<T> {
    pub fn push(&mut self, epoch: u64, entry: T) {
        self.last_seq += 1;
        if self.entries.len() == KEEP {
            self.entries.pop_front();
        }
        self.entries.push_back(Logged {
            seq: self.last_seq,
            epoch,
            entry,
        });
    }

    pub fn page(&self, cursor: u64, limit: usize) -> LogPage {
        let first = self.entries.front().map_or(self.last_seq + 1, |l| l.seq);
        let dropped = first.saturating_sub(cursor.saturating_add(1));
        let mut out = LogPage {
            entries: Vec::new(),
            cursor: cursor.max(first.saturating_sub(1)).min(self.last_seq),
            more: false,
            dropped,
        };
        let mut bytes = 0;
        for logged in self.entries.iter().filter(|l| l.seq > cursor) {
            let mut value = serde_json::to_value(&logged.entry).unwrap_or(Value::Null);
            if let Some(map) = value.as_object_mut() {
                map.insert("seq".into(), json!(logged.seq));
                map.insert("epoch".into(), json!(logged.epoch));
            }
            let size = value.to_string().len();
            if out.entries.len() == limit || (!out.entries.is_empty() && bytes + size > PAGE_MAX_BYTES) {
                out.more = true;
                break;
            }
            bytes += size;
            out.cursor = logged.seq;
            out.entries.push(value);
        }
        out
    }
}

#[derive(Default)]
pub struct Observations {
    pub console: ObservedLog<ConsoleEntry>,
    pub network: ObservedLog<NetworkEntry>,
}

/// `cursor` (default 0: the oldest kept entry) and `limit` (default 50,
/// at most 200).
fn page_args(args: &Value) -> Result<(u64, usize), BrowserError> {
    let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    let limit = match args.get("limit").and_then(Value::as_u64) {
        None => LIMIT_DEFAULT,
        Some(0) => return Err(BrowserError::invalid("'limit' must be at least 1").with_arg_keys(&["limit"])),
        Some(n) => usize::try_from(n).unwrap_or(LIMIT_MAX).min(LIMIT_MAX),
    };
    Ok((cursor, limit))
}

impl DesktopBrowserHost {
    pub(super) async fn observe(&self, session_id: &str, verb: Verb, args: &Value) -> Result<Success, BrowserError> {
        let label = self.resolve_tab(session_id, args)?;
        let (cursor, limit) = page_args(args)?;
        let capability = match verb {
            Verb::Console => CapabilityId::ConsoleObserve,
            _ => CapabilityId::NetworkObserve,
        };
        let fidelity = match self.engine.facts().capabilities.get(capability) {
            Support::Trusted => Fidelity::Trusted,
            Support::Synthetic => Fidelity::Synthetic,
            Support::Unavailable(reason) => return Err(BrowserError::capability(reason)),
        };
        if verb == Verb::Console {
            self.pull_console(&label).await;
        }
        let mut page = self
            .page_meta(&label)
            .ok_or_else(|| BrowserError::tab_not_found(&label).with_arg_keys(&["tabId"]))?;
        let read = {
            let registry = self.registry.lock();
            let record = registry
                .get(&label)
                .ok_or_else(|| BrowserError::tab_not_found(&label).with_arg_keys(&["tabId"]))?;
            match verb {
                Verb::Console => record.observed.console.page(cursor, limit),
                _ => record.observed.network.page(cursor, limit),
            }
        };
        match verb {
            Verb::Console => page.console = Some(read.entries),
            _ => page.network = Some(read.entries),
        }
        Ok(Success {
            tab: Some(self.tab_facts(&label)?),
            page: Some(page),
            data: Some(json!({
                "cursor": read.cursor,
                "more": read.more,
                "dropped": read.dropped,
                "fidelity": fidelity,
            })),
            ..Success::default()
        })
    }

    /// Bring a page-shim console up to date. Best effort: an open dialog
    /// blocks page script, and a failed pull still returns what the host
    /// holds.
    async fn pull_console(&self, label: &str) {
        let blocked = self
            .registry
            .lock()
            .get(label)
            .is_some_and(|record| record.dialogs.open().is_some());
        if blocked {
            return;
        }
        match self.engine.pull_console(label).await {
            Ok(entries) if !entries.is_empty() => {
                let mut registry = self.registry.lock();
                if let Some(record) = registry.get_mut(label) {
                    let epoch = record.epoch;
                    for entry in entries {
                        record.observed.console.push(epoch, entry);
                    }
                }
            }
            Ok(_) => {}
            Err(e) => log::debug!(
                "[browser-agent] console pull failed on tab {} ({:?})",
                label_prefix(label),
                e.kind
            ),
        }
    }
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
