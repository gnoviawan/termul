//! Local files on disk, as the agent browser reads them: the secrets
//! deny-list and the opened-handle checks uploads and `file://` pages
//! share, and the check a `file://` navigation target passes.
//!
//! A `file://` target is checked like an upload source: the host opens the
//! named file, and every check runs on the opened handle, never on the
//! path the agent named. The file must be a regular file with one name
//! (link count 1), name no NTFS stream, and look like no secret, by its
//! full path and by its path inside the project. A URL with a host (a UNC
//! share) and a directory are refused. The engine is sent to the file's
//! real path, never the agent's string, and the grant is that exact URL.
//! A file inside the session's project opens without a prompt; any other
//! asks the user (allow once or deny). Unlike uploads there is no size cap
//! and no git-ignore rule: a page is read in place, never sent anywhere.

use std::fs::{File, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::Url;
use tokio::sync::Semaphore;

use super::{BrowserError, DesktopBrowserHost, ERR_CONFIRMATION, ERR_TIMEOUT};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::files;

/// Directory names whose contents are never uploaded or opened.
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

/// On Windows, a path component carrying a `:` names an NTFS alternate
/// data stream. Elsewhere `:` is an ordinary file-name character.
pub fn names_a_stream(path: &Path) -> bool {
    let windows = std::path::MAIN_SEPARATOR == '\\';
    windows
        && path
            .components()
            .any(|c| matches!(c, Component::Normal(name) if name.to_string_lossy().contains(':')))
}

/// A root no project lives at: a drive or filesystem root, the home folder
/// itself, or a folder holding the home folder.
pub fn is_broad(canonical: &Path) -> bool {
    canonical.parent().is_none() || files::home_dir().is_some_and(|home| home.starts_with(canonical))
}

/// Why a file could not be opened as one regular, singly named file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenRefusal {
    Missing,
    NotAFile,
    HardLinked,
    Io,
}

/// An opened regular file, with where it really is.
pub struct OpenedFile {
    pub file: File,
    pub meta: Metadata,
    /// From the handle: symlinks and swaps resolved.
    pub real: PathBuf,
}

/// Open `at` and check the opened file is a regular file with one name.
pub fn open_regular(at: &Path) -> Result<OpenedFile, OpenRefusal> {
    // Opening a FIFO waits for a writer, forever: refuse anything the path
    // does not name as a regular file before opening it. The handle is
    // checked again below, so a swap after this read only reaches open.
    if std::fs::metadata(at).is_ok_and(|meta| !meta.is_file()) {
        return Err(OpenRefusal::NotAFile);
    }
    let file = files::open_nonblocking(at).map_err(|e| match e.kind() {
        // Windows refuses to open a folder as a file, and reports a folder
        // path with a trailing separator as not found: test the folder first.
        _ if at.is_dir() => OpenRefusal::NotAFile,
        io::ErrorKind::NotFound => OpenRefusal::Missing,
        _ => OpenRefusal::Io,
    })?;
    let meta = file.metadata().map_err(|_| OpenRefusal::Io)?;
    if !meta.is_file() {
        return Err(OpenRefusal::NotAFile);
    }
    if files::link_count(&file).map_err(|_| OpenRefusal::Io)? > 1 {
        return Err(OpenRefusal::HardLinked);
    }
    let real = files::opened_path(&file).map_err(|_| OpenRefusal::Io)?;
    Ok(OpenedFile { file, meta, real })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRefusal {
    /// Not a `file://` URL this host can map to a local path.
    InvalidUrl,
    /// A file URL with a host: a network share.
    NetworkShare,
    Stream,
    SecretFile,
    Missing,
    NotAFile,
    HardLinked,
    Io,
}

impl FileRefusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid_file_url",
            Self::NetworkShare => "network_share",
            Self::Stream => "file_stream",
            Self::SecretFile => "secret_file",
            Self::Missing => "file_not_found",
            Self::NotAFile => "not_a_file",
            Self::HardLinked => "hard_linked_file",
            Self::Io => "file_unreadable",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::InvalidUrl => "this file:// URL does not name a local file",
            Self::NetworkShare => "files on network shares (file://host/...) are never opened",
            Self::Stream => "this file:// URL names a file stream, not a file",
            Self::SecretFile => {
                "this file looks like a secret (keys, credentials, .env) and is never opened"
            }
            Self::Missing => "no such file",
            Self::NotAFile => "the file:// URL does not name a regular file (folders are never opened)",
            Self::HardLinked => "this file has another name (a hard link) and is never opened",
            Self::Io => "the file could not be read",
        }
    }

    pub fn into_error(self) -> BrowserError {
        BrowserError::invalid(self.message())
            .with_reason(self.reason())
            .with_arg_keys(&["url"])
    }
}

impl From<OpenRefusal> for FileRefusal {
    fn from(refusal: OpenRefusal) -> Self {
        match refusal {
            OpenRefusal::Missing => Self::Missing,
            OpenRefusal::NotAFile => Self::NotAFile,
            OpenRefusal::HardLinked => Self::HardLinked,
            OpenRefusal::Io => Self::Io,
        }
    }
}

/// A `file://` target that passed the checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFile {
    /// The opened file's real path.
    pub real: PathBuf,
    /// `file://` URL of `real`: what the engine loads and the grant names.
    pub url: Url,
    /// Inside the session's project folder.
    pub inside: bool,
    /// What the page may read on WebKit: the project folder for a project
    /// file, the file alone for any other.
    pub read_access: PathBuf,
}

impl LocalFile {
    /// The real path as the approver reads it.
    pub fn display(&self) -> String {
        plain(&self.real).to_string_lossy().into_owned()
    }
}

/// Whether `url` is a `file:` URL (checked further by [`check_local_file`]).
pub fn is_file_url(url: &str) -> bool {
    url.parse::<Url>().is_ok_and(|url| url.scheme() == "file")
}

/// A Windows verbatim drive path (`\\?\C:\...`) in its everyday spelling.
/// Every other verbatim form (`\\?\UNC\...`, `\\?\Volume{...}\...`) has
/// no everyday spelling and stays as it is.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if is_drive_path(rest) => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `X:\...`: a drive letter, a colon, a separator.
fn is_drive_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/')
}

/// Check the `file://` URL `url`; `root` is the session's project folder.
pub fn check_local_file(root: Option<&Path>, url: &str) -> Result<LocalFile, FileRefusal> {
    let parsed: Url = url.parse().map_err(|_| FileRefusal::InvalidUrl)?;
    if parsed.scheme() != "file" {
        return Err(FileRefusal::InvalidUrl);
    }
    if parsed.host_str().is_some_and(|host| !host.is_empty()) {
        return Err(FileRefusal::NetworkShare);
    }
    let named = parsed.to_file_path().map_err(|()| FileRefusal::InvalidUrl)?;
    if names_a_stream(&named) {
        return Err(FileRefusal::Stream);
    }
    if is_secret(&named) {
        return Err(FileRefusal::SecretFile);
    }
    let opened = open_regular(&named)?;
    let real = opened.real;
    if names_a_stream(&real) {
        return Err(FileRefusal::Stream);
    }
    if is_secret(&real) {
        return Err(FileRefusal::SecretFile);
    }
    let project = root
        .and_then(|root| std::fs::canonicalize(root).ok())
        .filter(|canonical| !is_broad(canonical));
    let rel = project.as_ref().and_then(|canonical| real.strip_prefix(canonical).ok());
    if rel.is_some_and(is_secret) {
        return Err(FileRefusal::SecretFile);
    }
    let inside = rel.is_some();
    let url = Url::from_file_path(&real).map_err(|()| FileRefusal::InvalidUrl)?;
    if url.host_str().is_some_and(|host| !host.is_empty()) {
        return Err(FileRefusal::NetworkShare);
    }
    let read_access = match (&project, inside) {
        (Some(canonical), true) => plain(canonical),
        _ => plain(&real),
    };
    Ok(LocalFile {
        real,
        url,
        inside,
        read_access,
    })
}

/// File checks that may run at once. A check on a hung mount can outlive
/// its caller's timeout in a blocking worker; the permit leaves with that
/// work, so a stuck disk holds at most this many workers.
pub const MAX_FILE_CHECKS: usize = 4;

static FILE_CHECKS: std::sync::LazyLock<Arc<Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(Semaphore::new(MAX_FILE_CHECKS)));

/// Why a bounded file check gave no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStall {
    /// Every check slot stayed taken until the wait ran out.
    Busy,
    /// The check did not finish in time.
    TimedOut,
    /// The blocking worker failed.
    Failed,
}

impl CheckStall {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Busy => "file_check_busy",
            Self::TimedOut => "file_check_timeout",
            Self::Failed => "file_check_failed",
        }
    }
}

/// [`check_local_file`] on a blocking worker, holding one of `slots` until
/// the work itself ends (not when the caller stops waiting), all within
/// `wait`.
pub async fn bounded_check(
    slots: &Arc<Semaphore>,
    root: Option<PathBuf>,
    url: String,
    wait: Duration,
) -> Result<Result<LocalFile, FileRefusal>, CheckStall> {
    let until = tokio::time::Instant::now() + wait;
    let permit = match tokio::time::timeout_at(until, Arc::clone(slots).acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => return Err(CheckStall::Failed),
        Err(_) => return Err(CheckStall::Busy),
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = permit;
        check_local_file(root.as_deref(), &url)
    });
    match tokio::time::timeout_at(until, work).await {
        Ok(Ok(checked)) => Ok(checked),
        Ok(Err(_)) => Err(CheckStall::Failed),
        Err(_) => Err(CheckStall::TimedOut),
    }
}

/// [`bounded_check`] on the host's shared slots.
pub async fn shared_check(root: Option<PathBuf>, url: String, wait: Duration) -> Result<Result<LocalFile, FileRefusal>, CheckStall> {
    bounded_check(&FILE_CHECKS, root, url, wait).await
}

impl DesktopBrowserHost {
    /// Check the file a `navigate` or `new_tab` call names, within the
    /// call's deadline.
    pub(super) async fn check_local_file(
        &self,
        session_id: &str,
        url: &str,
        deadline: Deadline,
    ) -> Result<LocalFile, BrowserError> {
        let root = (self.root_of)(session_id);
        let checked = match shared_check(root, url.to_string(), deadline.clamp(budgets::EVAL_STEP)).await {
            Ok(checked) => checked,
            Err(CheckStall::Failed) => return Err(BrowserError::internal("file check did not finish")),
            Err(stall) => {
                log::warn!(
                    "[browser-agent] file target check stalled code={ERR_TIMEOUT} reason={} session={}",
                    stall.reason(),
                    crate::logging::redact_session_id(session_id)
                );
                let message = match stall {
                    CheckStall::Busy => "other file checks are still running (a slow or unresponsive disk?); try again",
                    _ => "the file could not be checked in time (a slow or unresponsive disk?)",
                };
                return Err(BrowserError::new(ERR_TIMEOUT, message)
                    .with_reason(stall.reason())
                    .with_arg_keys(&["url"]));
            }
        };
        match checked {
            Ok(file) => {
                log::info!(
                    "[browser-agent] file target checked inside_project={} session={}",
                    file.inside,
                    crate::logging::redact_session_id(session_id)
                );
                Ok(file)
            }
            Err(refusal) => {
                log::info!(
                    "[browser-agent] file target refused code={} reason={} session={}",
                    super::ERR_INVALID_PARAMS,
                    refusal.reason(),
                    crate::logging::redact_session_id(session_id)
                );
                Err(refusal.into_error())
            }
        }
    }

    /// The URL a granted `file://` target loads: checked again (a swap
    /// since consent changes the real path, which then holds no grant),
    /// and always the real path's URL, never the agent's path, with the
    /// agent's query and fragment kept (the grant key ignores both).
    pub(super) async fn granted_file_target(
        &self,
        session_id: &str,
        url: &str,
        deadline: Deadline,
    ) -> Result<String, BrowserError> {
        let file = self.check_local_file(session_id, url, deadline).await?;
        if self.gate.file_read_access(session_id, &file.url).is_none() {
            log::info!(
                "[browser-agent] file target refused reason=file_changed session={}",
                crate::logging::redact_session_id(session_id)
            );
            return Err(BrowserError::new(
                ERR_CONFIRMATION,
                "the file changed after it was approved; open it again",
            )
            .with_reason("file_changed"));
        }
        let mut loaded = file.url;
        if let Ok(asked) = url.parse::<Url>() {
            loaded.set_query(asked.query());
            loaded.set_fragment(asked.fragment());
        }
        Ok(loaded.into())
    }

    /// Send tab `label` to `url`. A granted file loads through the engine
    /// with the read access its grant names (WKWebView reads files only
    /// that way); an engine without such a load navigates to it.
    pub(super) async fn load_page(&self, label: &str, url: String) -> Result<(), String> {
        let file = url
            .parse::<Url>()
            .ok()
            .filter(|parsed| parsed.scheme() == "file");
        let Some(file) = file else {
            return self.surface.navigate(label, url);
        };
        let session = self
            .registry
            .lock()
            .get(label)
            .and_then(|record| record.session_id().map(str::to_string));
        let access = session.and_then(|session| self.gate.file_read_access(&session, &file));
        let Some(read_access) = access else {
            return Err("the file is not granted to this tab's session".to_string());
        };
        match self.engine.load_file(label, &file, &read_access).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind == crate::browser_automation::engine::EngineErrorKind::Unsupported => {
                self.surface.navigate(label, url)
            }
            Err(e) => {
                log::warn!(
                    "[browser-agent] local file load failed tab={} ({:?})",
                    super::events::label_prefix(label),
                    e.kind
                );
                Err(format!("the engine did not load the file ({:?})", e.kind))
            }
        }
    }
}

#[cfg(test)]
#[path = "local_files_tests.rs"]
mod tests;
