//! The terminal-set hook behind the `terminals` watch: the manager tells one
//! observer whenever the set of terminals of a project changes (spawn, kill,
//! reap, or a terminal gaining its first / losing its last web attachment),
//! and reports the set without claim credentials.

use super::*;

/// What the observer receives: the project whose terminal set changed.
pub type TerminalSetCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// One observer slot shared by the manager and every terminal it spawns.
///
/// [`notify`](Self::notify) runs the callback on the calling thread, so
/// callers must hold none of the manager's locks: the callback reads the set
/// again through [`PtyManager::terminal_set`].
#[derive(Clone, Default)]
pub struct TerminalSetObserver {
    callback: Arc<RwLock<Option<TerminalSetCallback>>>,
}

impl TerminalSetObserver {
    /// Replace the callback (a host start installs its own).
    pub fn set(&self, callback: TerminalSetCallback) {
        *self.callback.write() = Some(callback);
    }

    /// The terminal set of `project_id` changed. A terminal without a project
    /// belongs to no watch scope, so it notifies nobody.
    pub(super) fn notify(&self, project_id: Option<&str>) {
        let Some(project_id) = project_id else {
            return;
        };
        let callback = self.callback.read().clone();
        if let Some(callback) = callback {
            callback(project_id);
        }
    }
}

/// One terminal as the `terminals` watch reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSetEntry {
    pub terminal_id: String,
    pub project_id: String,
    pub cwd: String,
    /// A web connection holds a live attachment.
    pub attached: bool,
}

impl PtyManager {
    /// Install the callback told about every change of a project's terminal set.
    pub fn set_terminal_set_observer(&self, callback: TerminalSetCallback) {
        self.set_observer.set(callback);
    }

    /// The terminals of `project_id` (detached ones included), ordered by id.
    /// Holds the terminal table's read lock only while it copies the entries.
    pub fn terminal_set(&self, project_id: &str) -> Vec<TerminalSetEntry> {
        let mut entries: Vec<TerminalSetEntry> = self
            .terminals
            .read()
            .values()
            .filter(|instance| instance.project_matches(project_id))
            .map(|instance| TerminalSetEntry {
                terminal_id: instance.id.clone(),
                project_id: project_id.to_string(),
                cwd: instance.cwd.clone(),
                attached: instance.has_web_attachment(),
            })
            .collect();
        entries.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
        entries
    }
}
