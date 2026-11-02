//! Per-session cache of the latest model controls, so a tail payload whose
//! window starts after the session's `session_created` /
//! `config_options_update` / `mode_update` records still carries them (the
//! controls twin of `last_commands`).
//!
//! An entry is the [`ControlsFold`] of every controls record this process
//! appended, plus whether the log has been folded into it. The first payload
//! read of an unseeded entry scans the log once and merges the result. The
//! fold keeps the newest value per control by seq, so a scan racing an
//! append converges to the same entry whichever lands first.

use std::ops::ControlFlow;
use std::sync::LazyLock;

use memchr::memmem;

use super::*;
use crate::acp::session_payload::{ControlsFold, SessionControls, CONTROLS_RECORD_TYPES};

#[derive(Default)]
struct CachedControls {
    /// The log on disk has been folded in.
    seeded: bool,
    fold: ControlsFold,
}

#[derive(Default)]
pub(super) struct ControlsCache(Mutex<HashMap<String, CachedControls>>);

impl ControlsCache {
    /// Merge the fold of an appended record into its session's entry.
    pub(super) fn note(&self, session_id: &str, appended: ControlsFold) {
        if appended != ControlsFold::default() {
            self.0
                .lock()
                .entry(session_id.to_string())
                .or_default()
                .fold
                .merge(appended);
        }
    }

    pub(super) fn forget(&self, session_id: &str) {
        self.0.lock().remove(session_id);
    }

    fn seeded(&self, session_id: &str) -> Option<Option<SessionControls>> {
        let cache = self.0.lock();
        let entry = cache.get(session_id).filter(|entry| entry.seeded)?;
        Some(entry.fold.controls())
    }

    fn seed(&self, session_id: &str, scanned: ControlsFold) -> Option<SessionControls> {
        let mut cache = self.0.lock();
        let entry = cache.entry(session_id.to_string()).or_default();
        entry.fold.merge(scanned);
        entry.seeded = true;
        entry.fold.controls()
    }
}

impl SessionPersistence {
    /// The session's latest controls. An unseeded session (after a host
    /// restart, or one no append of this process touched) scans the log once
    /// on the blocking pool.
    pub(super) async fn last_controls_async(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Option<SessionControls>> {
        if let Some(known) = self.inner.last_controls.seeded(session_id) {
            return Ok(known);
        }
        let metadata = self.metadata(session_id)?;
        let path = self.session_dir(&metadata.storage_key)?.join(MESSAGES_FILE);
        let id = session_id.to_string();
        let scanned = tokio::task::spawn_blocking(move || newest_controls(&path, &id))
            .await
            .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))??;
        Ok(self.inner.last_controls.seed(session_id, scanned))
    }
}

/// Log which controls a payload restores: counts and seq only, never values.
pub(super) fn log_payload_controls(session_id: &str, controls: Option<&SessionControls>) {
    let len = |value: Option<&Value>| value.and_then(Value::as_array).map_or(0, Vec::len);
    match controls {
        Some(controls) => log::info!(
            "[acp-history] session_payload controls session_id={} config_options={} \
             modes={} models={} controls_seq={}",
            crate::logging::redact_session_id(session_id),
            len(controls.config_options.as_ref()),
            len(controls
                .modes
                .as_ref()
                .and_then(|modes| modes.get("availableModes"))),
            len(controls
                .models
                .as_ref()
                .and_then(|models| models.get("availableModels"))),
            controls.controls_seq
        ),
        None => log::info!(
            "[acp-history] session_payload controls session_id={} none",
            crate::logging::redact_session_id(session_id)
        ),
    }
}

static CONTROLS_NEEDLES: LazyLock<[memmem::Finder<'static>; 3]> = LazyLock::new(|| {
    CONTROLS_RECORD_TYPES
        .map(|type_| memmem::Finder::new(&format!("\"type\":\"{type_}\"")).into_owned())
});

/// The controls fold of the log at `path`: one backward pass that parses
/// only lines naming a controls record type. It stops at the session's
/// `session_created` (its oldest controls record) or once no older record
/// can change the fold.
fn newest_controls(path: &Path, session_id: &str) -> io::Result<ControlsFold> {
    let mut fold = ControlsFold::default();
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(fold),
        Err(error) => return Err(error),
    };
    let end = file.metadata()?.len();
    scan_lines_backward(&mut file, end, 0, |line, terminated| {
        if !terminated
            || !CONTROLS_NEEDLES
                .iter()
                .any(|needle| needle.find(line).is_some())
        {
            return ControlFlow::Continue(());
        }
        let Ok(record) = serde_json::from_slice::<PersistedEventRecord>(line) else {
            return ControlFlow::Continue(());
        };
        if record.schema_version != SESSION_SCHEMA_VERSION || record.session_id != session_id {
            return ControlFlow::Continue(());
        }
        fold.observe(&record);
        if record.type_ == "session_created" || fold.is_complete() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    Ok(fold)
}

#[cfg(test)]
#[path = "controls_tests.rs"]
mod tests;
