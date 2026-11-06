//! Agent uploads. The agent names a file under the session's project root;
//! the host opens it, checks where the opened file really is, copies the
//! bytes from that same handle into the session's staging directory, and
//! hands the engine only the staged copy.
//!
//! Every check runs on the opened handle, never on the path the agent
//! named: a symlink, or a swap of the path after it was checked, can only
//! change which file was opened, and the handle's real location is what is
//! checked against the root and the secrets deny-list. A file with a
//! second name (a hard link) is refused: that name may sit outside the
//! root. The root is the session's project folder, and a root as broad as
//! the user's home or a whole drive is refused.

use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use uuid::Uuid;

use super::ports::TicketFile;
use super::reply::engine_error;
use super::tabs::RefNode;
use super::teardown::session_dir;
use super::{BrowserError, DesktopBrowserHost};
use crate::browser_automation::engine::files;
use crate::process_util::hide_console;

/// Largest file an agent may upload.
pub const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;

/// Directory names whose contents are never uploaded.
const SECRET_DIRS: [&str; 7] = [
    ".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker",
];
const SECRET_NAMES: [&str; 10] = [
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    ".dockercfg",
    "known_hosts",
    "authorized_keys",
];
const SECRET_PREFIXES: [&str; 6] = [
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
];
const SECRET_SUFFIXES: [&str; 10] = [
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".keystore",
    ".kdbx",
    ".keychain",
    ".keychain-db",
    ".ppk",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadRefusal {
    NoProjectRoot,
    /// The root is the user's home folder or a drive root.
    BroadRoot,
    Missing,
    NotAFile,
    OutsideRoot,
    SecretFile,
    IgnoredFile,
    HardLinked,
    TooLarge,
    /// The file changed while it was being copied.
    Changed,
    Io,
}

impl UploadRefusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::NoProjectRoot => "no_project_root",
            Self::BroadRoot => "project_root_too_broad",
            Self::Missing => "file_not_found",
            Self::NotAFile => "not_a_file",
            Self::OutsideRoot => "outside_project_root",
            Self::SecretFile => "secret_file",
            Self::IgnoredFile => "ignored_file",
            Self::HardLinked => "hard_linked_file",
            Self::TooLarge => "file_too_large",
            Self::Changed => "file_changed",
            Self::Io => "file_unreadable",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::NoProjectRoot => "this session has no project folder to upload from",
            Self::BroadRoot => {
                "the session's folder is a home folder or a drive root; open a project folder to upload from it"
            }
            Self::Missing => "no such file in the project",
            Self::NotAFile => "the upload path does not name a regular file",
            Self::OutsideRoot => "only files inside the project folder can be uploaded",
            Self::SecretFile => {
                "this file looks like a secret (keys, credentials, .env) and is never uploaded"
            }
            Self::IgnoredFile => "files the project's git ignores are never uploaded",
            Self::HardLinked => "this file has another name (a hard link) and is never uploaded",
            Self::TooLarge => "the file is larger than the 50 MB upload limit",
            Self::Changed => "the file changed while it was being staged; try again",
            Self::Io => "the file could not be read",
        }
    }

    fn into_error(self) -> BrowserError {
        BrowserError::invalid(self.message())
            .with_reason(self.reason())
            .with_arg_keys(&["path"])
    }
}

fn name_is_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_NAMES.contains(&name.as_str())
        || SECRET_PREFIXES.iter().any(|p| name.starts_with(p))
        || SECRET_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// Whether any component of `path` is on the secrets deny-list.
pub fn is_secret(path: &Path) -> bool {
    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    let Some((file, dirs)) = names.split_last() else {
        return false;
    };
    dirs.iter().any(|d| SECRET_DIRS.contains(&d.as_str()))
        || SECRET_DIRS.contains(&file.as_str())
        || name_is_secret(file)
}

/// A path component carrying a `:` names an NTFS alternate data stream.
fn names_a_stream(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(name) if name.to_string_lossy().contains(':')))
}

/// Whether the project's git ignores `rel`. No git, or no repository,
/// ignores nothing.
fn git_ignores(root: &Path, rel: &Path) -> bool {
    let mut git = std::process::Command::new("git");
    hide_console(&mut git)
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-q", "--"])
        .arg(rel)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    git.status().is_ok_and(|status| status.code() == Some(0))
}

/// The upload's file, open, with the name the page will see.
pub struct OpenSource {
    file: File,
    len: u64,
    name: String,
}

impl OpenSource {
    /// What the consent ticket names: the base name and size, never the path.
    pub fn ticket_file(&self) -> TicketFile {
        TicketFile {
            name: self.name.clone(),
            bytes: self.len,
        }
    }
}

/// A root no project lives at: a drive or filesystem root, or the home
/// folder itself.
fn is_broad(canonical: &Path) -> bool {
    canonical.parent().is_none() || files::home_dir().is_some_and(|home| home == canonical)
}

/// Keep the base name readable but harmless as one path component.
fn staged_name(real: &Path) -> String {
    let name: String = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(128)
        .collect();
    let name = name.trim_matches(['.', ' ']).to_string();
    if name.is_empty() {
        "upload".to_string()
    } else {
        name
    }
}

/// Open `requested` (relative to `root`, or absolute inside it) and check
/// the opened file.
pub fn open_source(root: &Path, requested: &str) -> Result<OpenSource, UploadRefusal> {
    // Opened through the root as given: a canonical Windows root is a
    // verbatim path, where `..` is a literal name.
    let canonical = std::fs::canonicalize(root).map_err(|_| UploadRefusal::NoProjectRoot)?;
    if is_broad(&canonical) {
        return Err(UploadRefusal::BroadRoot);
    }
    let named = Path::new(requested);
    if names_a_stream(named) {
        return Err(UploadRefusal::NotAFile);
    }
    if is_secret(named) {
        return Err(UploadRefusal::SecretFile);
    }
    let at = root.join(named);
    let file = File::open(&at).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => UploadRefusal::Missing,
        // Windows refuses to open a folder as a file.
        _ if at.is_dir() => UploadRefusal::NotAFile,
        _ => UploadRefusal::Io,
    })?;
    let meta = file.metadata().map_err(|_| UploadRefusal::Io)?;
    if !meta.is_file() {
        return Err(UploadRefusal::NotAFile);
    }
    if files::link_count(&file).map_err(|_| UploadRefusal::Io)? > 1 {
        return Err(UploadRefusal::HardLinked);
    }
    let real = files::opened_path(&file).map_err(|_| UploadRefusal::Io)?;
    let rel = real
        .strip_prefix(&canonical)
        .map_err(|_| UploadRefusal::OutsideRoot)?;
    if is_secret(rel) {
        return Err(UploadRefusal::SecretFile);
    }
    if git_ignores(root, rel) {
        return Err(UploadRefusal::IgnoredFile);
    }
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(UploadRefusal::TooLarge);
    }
    Ok(OpenSource {
        file,
        len: meta.len(),
        name: staged_name(&real),
    })
}

/// Copy the opened file into a fresh directory under `staging` and return
/// the staged path.
pub fn stage(source: OpenSource, staging: &Path) -> Result<PathBuf, UploadRefusal> {
    let dir = staging.join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|_| UploadRefusal::Io)?;
    let dest = dir.join(&source.name);
    let copied = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
        .and_then(|mut out| io::copy(&mut (&source.file).take(MAX_UPLOAD_BYTES + 1), &mut out));
    match copied {
        Ok(n) if n == source.len => Ok(dest),
        Ok(_) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(UploadRefusal::Changed)
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(UploadRefusal::Io)
        }
    }
}

fn path_arg(args: &Value) -> Result<String, BrowserError> {
    args.get("path")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BrowserError::invalid("upload needs 'path'").with_arg_keys(&["path"]))
}

impl DesktopBrowserHost {
    /// Open and check the file an upload call names, without staging it.
    pub(super) async fn upload_source(
        &self,
        session_id: &str,
        args: &Value,
    ) -> Result<OpenSource, BrowserError> {
        let requested = path_arg(args)?;
        let root =
            (self.root_of)(session_id).ok_or_else(|| UploadRefusal::NoProjectRoot.into_error())?;
        tokio::task::spawn_blocking(move || open_source(&root, &requested))
            .await
            .map_err(|_| BrowserError::internal("upload check did not finish"))?
            .map_err(|refusal| {
                log::info!("[browser-agent] upload refused reason={}", refusal.reason());
                refusal.into_error()
            })
    }

    /// Stage the file the call names and set it on the file input `input`.
    pub(super) async fn upload(
        &self,
        session_id: &str,
        label: &str,
        input: &RefNode,
        args: &Value,
    ) -> Result<(), BrowserError> {
        let source = self.upload_source(session_id, args).await?;
        let root = self
            .surface
            .session_data_root()
            .map_err(BrowserError::internal)?;
        let staging = session_dir(&root, session_id).join("staging");
        let staged = tokio::task::spawn_blocking(move || stage(source, &staging))
            .await
            .map_err(|_| BrowserError::internal("upload staging did not finish"))?
            .map_err(|refusal| {
                log::info!("[browser-agent] upload refused reason={}", refusal.reason());
                refusal.into_error()
            })?;
        let frame = (!input.frame.is_empty()).then_some(input.frame.as_str());
        self.engine
            .set_input_files(label, frame, &input.path, &[staged])
            .await
            .map_err(|e| engine_error(e, label))?;
        log::info!(
            "[browser-agent] upload staged and set on tab {}",
            super::events::label_prefix(label)
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;
