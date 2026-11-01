//! Per-session cache of the last known controls (`SessionControls`), so a tail
//! payload whose window starts after the session's `session_created` still
//! carries them. Appends fold into a known entry; a miss folds the whole log
//! once on the blocking pool.

use std::io::BufRead;
use std::sync::LazyLock;

use memchr::memmem;

use super::*;
use crate::acp::session_payload::{SessionControls, CONTROL_RECORD_TYPES};

pub(super) enum CachedControls {
    /// Folded from the log and every append since.
    Known(Box<SessionControls>),
    /// A log fold is in flight. An append that lands meanwhile sets `raced`,
    /// since the fold may have read the file before that record was written.
    Seeding { raced: bool },
}

pub(super) fn is_control_record(type_: &str) -> bool {
    CONTROL_RECORD_TYPES.contains(&type_)
}

static CONTROL_NEEDLES: LazyLock<Vec<memmem::Finder<'static>>> = LazyLock::new(|| {
    CONTROL_RECORD_TYPES
        .iter()
        .map(|type_| memmem::Finder::new(format!("\"type\":\"{type_}\"").as_bytes()).into_owned())
        .collect()
});

/// The controls `materialize_session_payload` folds from a full replay of
/// `path`: one forward pass that parses only lines naming a control type.
fn fold_log_controls(path: &Path, session_id: &str) -> io::Result<SessionControls> {
    let mut controls = SessionControls::default();
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(controls),
        Err(error) => return Err(error),
    };
    let mut reader = io::BufReader::new(file);
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        if line.ends_with(b"\n")
            && CONTROL_NEEDLES
                .iter()
                .any(|needle| needle.find(&line).is_some())
        {
            if let Ok(record) = serde_json::from_slice::<PersistedEventRecord>(&line) {
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id
                {
                    controls.apply(&record);
                }
            }
        }
        line.clear();
    }
    Ok(controls)
}

impl SessionPersistence {
    /// Fold an appended control record into the session's known controls.
    /// Called in append order, under the session's send lock.
    pub(super) fn note_control_record(&self, record: &PersistedEventRecord) {
        match self.inner.last_controls.lock().get_mut(&record.session_id) {
            Some(CachedControls::Known(controls)) => controls.apply(record),
            Some(CachedControls::Seeding { raced }) => *raced = true,
            None => {}
        }
    }

    /// The session's last known controls. A miss (after a host restart, or a
    /// session no tail payload of this process read) folds the log once and
    /// keeps the result unless an append raced the fold.
    pub(super) async fn last_controls_async(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Option<SessionControls>> {
        let seeding = {
            let mut cache = self.inner.last_controls.lock();
            match cache.get(session_id) {
                Some(CachedControls::Known(controls)) => {
                    return Ok(SessionControls::clone(controls).known())
                }
                Some(CachedControls::Seeding { .. }) => false,
                None => {
                    cache.insert(
                        session_id.to_string(),
                        CachedControls::Seeding { raced: false },
                    );
                    true
                }
            }
        };
        let folded = self.fold_controls_from_log(session_id).await;
        if seeding {
            let mut cache = self.inner.last_controls.lock();
            match (cache.get(session_id), &folded) {
                (Some(CachedControls::Seeding { raced: false }), Ok(controls)) => {
                    cache.insert(
                        session_id.to_string(),
                        CachedControls::Known(Box::new(controls.clone())),
                    );
                }
                (Some(CachedControls::Seeding { .. }), _) => {
                    cache.remove(session_id);
                    log::debug!(
                        "[acp-history] controls fold not cached (raced or failed) session_id={}",
                        crate::logging::redact_session_id(session_id)
                    );
                }
                _ => {}
            }
        }
        Ok(folded?.known())
    }

    /// Flush first, so every record enqueued before the `Seeding` marker is
    /// on disk when the fold reads the log.
    async fn fold_controls_from_log(self: &Arc<Self>, session_id: &str) -> Result<SessionControls> {
        self.flush_session(session_id).await?;
        let metadata = self.metadata(session_id)?;
        let path = self.session_dir(&metadata.storage_key)?.join(MESSAGES_FILE);
        let id = session_id.to_string();
        let controls = tokio::task::spawn_blocking(move || fold_log_controls(&path, &id))
            .await
            .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))??;
        log::info!(
            "[acp-history] controls folded from log session_id={} found={}",
            crate::logging::redact_session_id(session_id),
            controls != SessionControls::default()
        );
        Ok(controls)
    }
}
