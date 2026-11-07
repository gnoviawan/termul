//! File persistence for the policy documents.
//!
//! One schema-versioned JSON file per project plus one app file, under the
//! app-data root and never inside a project tree. Edits are serialized per
//! file by an async lock and gated by a revision compare-and-swap. A file
//! written by a newer build is read-only here: edits are refused and the
//! file is never rewritten. A file this build cannot parse fails closed: the
//! scope reads as ephemeral (no global profile), read-only, so the user's file
//! stays as it is until it is repaired or removed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::acp::atomic_file;

use super::model::{
    validate_project_id, ActionClass, AppPolicy, AppPreapproval, Preapproval, ProfileMode,
    ProjectPolicy, ProjectPreapproval,
};
use super::origin::{CanonicalOrigin, OriginPattern};
use super::refusal::PolicyRefusal;

/// Schema version this build writes and fully understands.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreapprovalFile {
    action: ActionClass,
    origin: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    allow_list: Vec<String>,
    #[serde(default)]
    preapprovals: Vec<PreapprovalFile>,
    #[serde(default = "default_profile_mode")]
    profile_mode: ProfileMode,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppFile {
    version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default = "default_true")]
    global_profile_enabled: bool,
    #[serde(default)]
    ask_before_password_submit: bool,
    #[serde(default)]
    preapprovals: Vec<PreapprovalFile>,
}

fn default_profile_mode() -> ProfileMode {
    ProfileMode::Global
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

fn pattern_entries(entries: &[String]) -> Vec<OriginPattern> {
    entries
        .iter()
        .filter_map(|entry| match OriginPattern::parse(entry) {
            Ok(pattern) => Some(pattern),
            Err(error) => {
                log::warn!(
                    "[browser-policy] dropped an unreadable allow-list entry: {}",
                    error.reason()
                );
                None
            }
        })
        .collect()
}

fn preapproval_entries(
    entries: &[PreapprovalFile],
    build: impl Fn(ActionClass, CanonicalOrigin) -> Result<Preapproval, PolicyRefusal>,
) -> Vec<Preapproval> {
    entries
        .iter()
        .filter_map(|entry| {
            let origin = CanonicalOrigin::parse(&entry.origin).ok()?;
            match build(entry.action, origin) {
                Ok(preapproval) => Some(preapproval),
                Err(_) => {
                    log::warn!("[browser-policy] dropped a pre-approval this scope cannot hold");
                    None
                }
            }
        })
        .collect()
}

fn project_preapproval(
    action: ActionClass,
    origin: CanonicalOrigin,
) -> Result<Preapproval, PolicyRefusal> {
    ProjectPreapproval::new(action, origin).map(|p| p.into_inner())
}

fn app_preapproval(
    action: ActionClass,
    origin: CanonicalOrigin,
) -> Result<Preapproval, PolicyRefusal> {
    AppPreapproval::new(action, origin).map(|p| p.into_inner())
}

fn preapproval_files(items: &[Preapproval]) -> Vec<PreapprovalFile> {
    items
        .iter()
        .map(|p| PreapprovalFile {
            action: p.action,
            origin: p.origin.as_str().to_string(),
        })
        .collect()
}

impl ProjectFile {
    fn into_policy(self, read_only: bool) -> ProjectPolicy {
        ProjectPolicy {
            revision: self.revision,
            read_only,
            allow_list: pattern_entries(&self.allow_list),
            preapprovals: preapproval_entries(&self.preapprovals, project_preapproval),
            profile_mode: self.profile_mode,
        }
    }

    fn from_policy(policy: &ProjectPolicy) -> Self {
        Self {
            version: SCHEMA_VERSION,
            revision: policy.revision,
            allow_list: policy
                .allow_list
                .iter()
                .map(OriginPattern::to_canonical_string)
                .collect(),
            preapprovals: preapproval_files(&policy.preapprovals),
            profile_mode: policy.profile_mode,
        }
    }
}

impl AppFile {
    fn into_policy(self, read_only: bool) -> AppPolicy {
        AppPolicy {
            revision: self.revision,
            read_only,
            global_profile_enabled: self.global_profile_enabled,
            ask_before_password_submit: self.ask_before_password_submit,
            preapprovals: preapproval_entries(&self.preapprovals, app_preapproval),
        }
    }

    fn from_policy(policy: &AppPolicy) -> Self {
        Self {
            version: SCHEMA_VERSION,
            revision: policy.revision,
            global_profile_enabled: policy.global_profile_enabled,
            ask_before_password_submit: policy.ask_before_password_submit,
            preapprovals: preapproval_files(&policy.preapprovals),
        }
    }
}

/// A policy document as stored: how it reads from and writes to its file.
trait PolicyDoc: Default + Send + 'static {
    type File: for<'de> Deserialize<'de>;

    fn from_file(file: Self::File, read_only: bool) -> Self;
    /// What an unparseable file reads as: read-only, and never wider than
    /// the defaults (no global profile, password submits prompt).
    fn fail_closed() -> Self;
    fn to_bytes(&self) -> serde_json::Result<Vec<u8>>;
    fn read_only(&self) -> bool;
    fn revision(&self) -> u64;
    fn set_revision(&mut self, revision: u64);
}

impl PolicyDoc for ProjectPolicy {
    type File = ProjectFile;

    fn from_file(file: ProjectFile, read_only: bool) -> Self {
        file.into_policy(read_only)
    }

    fn fail_closed() -> Self {
        Self {
            read_only: true,
            profile_mode: ProfileMode::Ephemeral,
            ..Self::default()
        }
    }

    fn to_bytes(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec_pretty(&ProjectFile::from_policy(self))
    }

    fn read_only(&self) -> bool {
        self.read_only
    }

    fn revision(&self) -> u64 {
        self.revision
    }

    fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }
}

impl PolicyDoc for AppPolicy {
    type File = AppFile;

    fn from_file(file: AppFile, read_only: bool) -> Self {
        file.into_policy(read_only)
    }

    fn fail_closed() -> Self {
        Self {
            read_only: true,
            global_profile_enabled: false,
            ask_before_password_submit: true,
            ..Self::default()
        }
    }

    fn to_bytes(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec_pretty(&AppFile::from_policy(self))
    }

    fn read_only(&self) -> bool {
        self.read_only
    }

    fn revision(&self) -> u64 {
        self.revision
    }

    fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }
}

/// Parse one policy file. A newer version is read leniently and marked
/// read-only; a file that does not parse fails closed.
fn parse_doc<T: PolicyDoc>(bytes: &[u8]) -> T {
    let newer = match serde_json::from_slice::<VersionProbe>(bytes) {
        Ok(VersionProbe { version }) => version > SCHEMA_VERSION,
        Err(error) => return unreadable(false, &error),
    };
    match serde_json::from_slice::<T::File>(bytes) {
        Ok(file) => T::from_file(file, newer),
        Err(error) => unreadable(newer, &error),
    }
}

fn unreadable<T: PolicyDoc>(newer: bool, error: &serde_json::Error) -> T {
    log::error!(
        "[browser-policy] a policy file does not parse (newer_schema={newer}, line {} column {}); using an ephemeral, read-only policy until it is repaired",
        error.line(),
        error.column()
    );
    T::fail_closed()
}

/// Per-scope async locks, created on first use.
#[derive(Default)]
struct ScopeLocks {
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl ScopeLocks {
    fn lock_for(&self, key: &str) -> Arc<AsyncMutex<()>> {
        self.locks
            .lock()
            .entry(key.to_string())
            .or_default()
            .clone()
    }
}

pub struct PolicyFiles {
    root: PathBuf,
    locks: ScopeLocks,
}

impl PolicyFiles {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            locks: ScopeLocks::default(),
        }
    }

    fn app_path(&self) -> PathBuf {
        self.root.join("app.json")
    }

    fn project_path(&self, project_id: &str) -> Result<PathBuf, PolicyRefusal> {
        let id = validate_project_id(project_id)?;
        Ok(self.root.join("projects").join(format!("{id}.json")))
    }

    pub async fn read_project(&self, project_id: &str) -> Result<ProjectPolicy, PolicyRefusal> {
        read_doc(self.project_path(project_id)?).await
    }

    pub async fn read_app(&self) -> Result<AppPolicy, PolicyRefusal> {
        read_doc(self.app_path()).await
    }

    /// Apply `edit` to a project policy under its lock. Returns the policy
    /// after the edit and whether it changed (and was therefore persisted).
    pub async fn edit_project(
        &self,
        project_id: &str,
        expected_revision: u64,
        edit: impl FnOnce(&mut ProjectPolicy) -> Result<bool, PolicyRefusal>,
    ) -> Result<(ProjectPolicy, bool), PolicyRefusal> {
        let path = self.project_path(project_id)?;
        let lock = self.locks.lock_for(&format!("project/{project_id}"));
        let _guard = lock.lock().await;
        edit_doc(path, expected_revision, edit).await
    }

    pub async fn edit_app(
        &self,
        expected_revision: u64,
        edit: impl FnOnce(&mut AppPolicy) -> Result<bool, PolicyRefusal>,
    ) -> Result<(AppPolicy, bool), PolicyRefusal> {
        let lock = self.locks.lock_for("app");
        let _guard = lock.lock().await;
        edit_doc(self.app_path(), expected_revision, edit).await
    }
}

async fn read_doc<T: PolicyDoc>(path: PathBuf) -> Result<T, PolicyRefusal> {
    let loaded = spawn_io(move || match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(parse_doc::<T>(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    })
    .await?;
    Ok(loaded.unwrap_or_default())
}

/// Read, check, edit and persist one document. The caller holds its lock.
async fn edit_doc<T: PolicyDoc>(
    path: PathBuf,
    expected_revision: u64,
    edit: impl FnOnce(&mut T) -> Result<bool, PolicyRefusal>,
) -> Result<(T, bool), PolicyRefusal> {
    let mut doc = read_doc::<T>(path.clone()).await?;
    if doc.read_only() {
        return Err(PolicyRefusal::ReadOnly);
    }
    let current = doc.revision();
    if current != expected_revision {
        return Err(PolicyRefusal::RevisionConflict { current });
    }
    if !edit(&mut doc)? {
        return Ok((doc, false));
    }
    doc.set_revision(current + 1);
    let bytes = doc.to_bytes().map_err(|error| {
        log::error!("[browser-policy] could not serialize a policy: {error}");
        PolicyRefusal::Storage
    })?;
    spawn_io(move || atomic_file::replace(&path, &bytes)).await?;
    Ok((doc, true))
}

/// Run blocking file I/O off the async runtime.
async fn spawn_io<R: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<R> + Send + 'static,
) -> Result<R, PolicyRefusal> {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            log::error!("[browser-policy] policy file I/O failed: {error}");
            Err(PolicyRefusal::Storage)
        }
        Err(error) => {
            log::error!("[browser-policy] policy file task failed: {error}");
            Err(PolicyRefusal::Storage)
        }
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
