//! Suggestions the user has answered: dismissed ones are never offered
//! again, accepted ones were turned into a chat that builds the automation.

use std::collections::HashSet;

use rusqlite::params;

use super::{AutomationStore, StoreResult};

impl AutomationStore {
    pub fn dismiss_suggestion(
        &self,
        project_id: &str,
        fingerprint: &str,
        now: i64,
    ) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO automation_suggestion_dismissed (project_id, fingerprint, dismissed_at) \
             VALUES (?1, ?2, ?3)",
            params![project_id, fingerprint, now],
        )?;
        Ok(())
    }

    pub fn accept_suggestion(
        &self,
        project_id: &str,
        fingerprint: &str,
        now: i64,
    ) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT OR REPLACE INTO automation_suggestion_accepted (project_id, fingerprint, accepted_at) \
             VALUES (?1, ?2, ?3)",
            params![project_id, fingerprint, now],
        )?;
        Ok(())
    }

    /// Fingerprints of `project_id` the user dismissed or accepted.
    pub fn answered_suggestions(&self, project_id: &str) -> StoreResult<HashSet<String>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT fingerprint FROM automation_suggestion_dismissed WHERE project_id = ?1 \
             UNION SELECT fingerprint FROM automation_suggestion_accepted WHERE project_id = ?1",
        )?;
        let rows = stmt.query_map(params![project_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
