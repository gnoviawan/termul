//! Names of the secrets a project holds. The values live in the OS keychain,
//! which cannot list entries, so the names are kept here.

use rusqlite::params;

use super::{AutomationStore, StoreResult};

impl AutomationStore {
    pub fn add_secret_name(&self, project_id: &str, name: &str) -> StoreResult<()> {
        self.conn()?.execute(
            "INSERT OR IGNORE INTO automation_secret_name (project_id, name) VALUES (?1, ?2)",
            params![project_id, name],
        )?;
        Ok(())
    }

    pub fn remove_secret_name(&self, project_id: &str, name: &str) -> StoreResult<()> {
        self.conn()?.execute(
            "DELETE FROM automation_secret_name WHERE project_id = ?1 AND name = ?2",
            params![project_id, name],
        )?;
        Ok(())
    }

    /// Sorted by name.
    pub fn secret_names(&self, project_id: &str) -> StoreResult<Vec<String>> {
        let db = self.conn()?;
        let mut stmt = db.prepare(
            "SELECT name FROM automation_secret_name WHERE project_id = ?1 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![project_id], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
