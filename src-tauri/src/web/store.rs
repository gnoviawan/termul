//! Server-side generic key-value store for the web client (issue #613).
//!
//! The browser client persists terminal layout, settings, editor state,
//! command history, snapshots, SSH profiles, etc. through `persistenceApi`.
//! On desktop that lands in Tauri's plugin-store; in the standalone web
//! client it previously fell back to a `localStorage` stub — per-browser
//! only, so switching browsers or refreshing in a different browser lost
//! everything. This store gives the server a durable home for that state: a
//! single JSON file written atomically (temp + rename + fsync, the same
//! `atomic_file` machinery `FileProjectRegistry::save_atomic` uses), so the
//! state survives browser switches and server restarts.
//!
//! Exposed to browsers as the `store_read` / `store_write` / `store_delete`
//! WS requests (see `ws.rs`). The client debounces high-frequency writes, so
//! write volume here is low.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde_json::Value;
use tracing::{info, warn};

use crate::acp::atomic_file;

/// A key → arbitrary-JSON-value map persisted to one JSON file.
///
/// All mutation goes through a single `parking_lot::Mutex`; each write
/// serializes the whole map and replaces the file atomically. The file is a
/// bare JSON object (`{ "key": value }`); an empty store is `{}`.
pub struct WebStore {
    path: PathBuf,
    inner: Mutex<Option<HashMap<String, Value>>>,
}

impl WebStore {
    /// Open (and lazily load) the store at `path`.
    ///
    /// - Missing file → empty store (first run).
    /// - Corrupt file → backed up to `<path>.corrupt-<ts>.bak`, then treated
    ///   as empty — the web client degrades to defaults rather than the
    ///   server refusing to start (same corrupt-handling posture as
    ///   `AcpCatalogService` / `AcpInstallService`).
    /// - Other read failure → warn + empty store (the store degrades; the
    ///   next successful write recreates the file).
    #[must_use]
    pub fn open(path: PathBuf) -> Self {
        let data = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<HashMap<String, Value>>(&bytes) {
                Ok(map) => Some(map),
                Err(e) => match atomic_file::backup_corrupt(&path, &bytes) {
                    Ok(_) => {
                        warn!(
                                "store file '{}' is corrupt ({e}); backed up and starting with an empty store",
                                path.display()
                            );
                        Some(HashMap::new())
                    }
                    Err(backup_err) => {
                        warn!(
                                "store file '{}' is corrupt ({e}) and backup failed: {backup_err}; store is unavailable",
                                path.display()
                            );
                        None
                    }
                },
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                info!(
                    "store file '{}' not found; starting with an empty store",
                    path.display()
                );
                Some(HashMap::new())
            }
            Err(e) => {
                warn!(
                    "could not read store file '{}': {e}; store is unavailable",
                    path.display()
                );
                None
            }
        };
        Self {
            path,
            inner: Mutex::new(data),
        }
    }

    /// Read a value, or `None` when the key is absent.
    pub fn read(&self, key: &str) -> Result<Option<Value>, io::Error> {
        let lock = self.inner.lock();
        let map = lock
            .as_ref()
            .ok_or_else(|| io::Error::other("STORE_UNAVAILABLE"))?;
        Ok(map.get(key).cloned())
    }

    /// Write a value, persisting atomically. Returns the IO error on failure.
    pub fn write(&self, key: &str, value: Value, expected: Option<Value>) -> io::Result<bool> {
        let mut lock = self.inner.lock();
        let map = lock
            .as_mut()
            .ok_or_else(|| io::Error::other("STORE_UNAVAILABLE"))?;

        if expected.is_some() && map.get(key) != expected.as_ref() {
            return Ok(false); // CAS failed
        }

        let mut next = map.clone();
        next.insert(key.to_string(), value);

        let bytes = serde_json::to_vec(&next).map_err(|e| io::Error::other(e.to_string()))?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "store file exceeds 10MB limit",
            ));
        }
        atomic_file::replace(&self.path, &bytes)?;

        *map = next;
        Ok(true)
    }

    /// Delete a key, persisting atomically. Returns whether the key existed.
    pub fn delete(&self, key: &str) -> io::Result<bool> {
        let mut lock = self.inner.lock();
        let map = lock
            .as_mut()
            .ok_or_else(|| io::Error::other("STORE_UNAVAILABLE"))?;

        let mut next = map.clone();
        let removed = next.remove(key).is_some();

        let bytes = serde_json::to_vec(&next).map_err(|e| io::Error::other(e.to_string()))?;
        atomic_file::replace(&self.path, &bytes)?;

        *map = next;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests;
