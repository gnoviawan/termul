//! Provenance of sessions imported from another client.

use super::*;

impl SessionPersistence {
    /// Set the last activity of an imported session back to the time the
    /// original chat last ran. Writing the imported history stamps every record
    /// with the import time, which would sort the chat as brand new. A time that
    /// is not in the past leaves the stamp alone.
    pub async fn restore_last_activity(&self, session_id: &str, at: u64) -> Result<()> {
        let entry = self
            .inner
            .catalog
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)?;
        let snapshot = {
            let mut metadata = entry.lock();
            if at == 0 || at >= metadata.last_activity_at {
                return Ok(());
            }
            metadata.last_activity_at = at;
            metadata.clone()
        };
        self.persist_metadata(&snapshot)?;
        self.persist_index().await
    }
}
