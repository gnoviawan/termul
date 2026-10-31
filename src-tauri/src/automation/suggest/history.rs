//! The user prompts the detector reads: `user_prompt` records of the
//! project's persisted chats, through the host's session persistence.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use super::Prompt;
use crate::acp::session_persistence::{user_prompt_text, SessionPersistence};

/// Newest chats first; older ones are not read.
const MAX_SESSIONS: usize = 300;
const MAX_PROMPT_BYTES: usize = 2048;

pub trait PromptHistory: Send + Sync {
    /// User prompts of `project_id`'s chats active since `since_ms`. Blocking.
    fn prompts(&self, project_id: &str, since_ms: i64) -> Vec<Prompt>;
}

struct CachedSession {
    last_seq: u64,
    prompts: Arc<Vec<Prompt>>,
}

/// Reads each chat's log once per `last_seq`: an unchanged chat is served
/// from memory. The cache keeps only the chats the last read of a project
/// saw; a chat whose log failed to read is read again next time.
pub struct SessionHistory {
    persistence: Arc<SessionPersistence>,
    cache: Mutex<HashMap<String, Arc<HashMap<String, CachedSession>>>>,
}

impl SessionHistory {
    pub fn new(persistence: Arc<SessionPersistence>) -> Self {
        Self {
            persistence,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn read(&self, session_id: &str) -> Option<Vec<Prompt>> {
        match self.persistence.replay_after(session_id, 0) {
            Ok(records) => Some(
                records
                    .into_iter()
                    .filter(|record| record.type_ == "user_prompt")
                    .filter_map(|record| {
                        let text = user_prompt_text(&record.payload)?;
                        Some(Prompt {
                            at_ms: i64::try_from(record.recorded_at).ok()?,
                            text: truncate(text),
                        })
                    })
                    .collect(),
            ),
            Err(error) => {
                log::warn!("[Automation] suggestions skipped a chat log: {error}");
                None
            }
        }
    }
}

impl PromptHistory for SessionHistory {
    fn prompts(&self, project_id: &str, since_ms: i64) -> Vec<Prompt> {
        let sessions: Vec<_> = self
            .persistence
            .list_sessions()
            .into_iter()
            .filter(|entry| {
                entry.project_id.as_deref() == Some(project_id)
                    && i64::try_from(entry.last_activity_at).is_ok_and(|at| at >= since_ms)
            })
            .take(MAX_SESSIONS)
            .collect();

        let previous = self
            .cache
            .lock()
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        let mut next = HashMap::with_capacity(sessions.len());
        let mut reread = 0usize;
        for entry in sessions {
            let prompts = match previous.get(&entry.session_id) {
                Some(cached) if cached.last_seq == entry.last_seq => cached.prompts.clone(),
                _ => {
                    reread += 1;
                    let Some(prompts) = self.read(&entry.session_id) else {
                        continue;
                    };
                    Arc::new(prompts)
                }
            };
            next.insert(
                entry.session_id,
                CachedSession {
                    last_seq: entry.last_seq,
                    prompts,
                },
            );
        }
        let prompts: Vec<Prompt> = next
            .values()
            .flat_map(|cached| cached.prompts.iter().cloned())
            .collect();
        log::debug!(
            "[Automation] suggestion history for {project_id}: {} chats ({reread} read), {} prompts",
            next.len(),
            prompts.len()
        );
        self.cache
            .lock()
            .insert(project_id.to_string(), Arc::new(next));
        prompts
    }
}

/// At most 2 KB, cut on a character boundary.
fn truncate(mut text: String) -> String {
    if text.len() > MAX_PROMPT_BYTES {
        let mut end = MAX_PROMPT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// Any `fn(project_id, since_ms)` is a history; tests pass closures.
impl<F> PromptHistory for F
where
    F: Fn(&str, i64) -> Vec<Prompt> + Send + Sync,
{
    fn prompts(&self, project_id: &str, since_ms: i64) -> Vec<Prompt> {
        self(project_id, since_ms)
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
