//! The kiosk file-tool policy (spine AD-18), applied by the parent to every
//! canvas call before it reaches a renderer.
//!
//! The editor never touches the file system for an agent. `file.save` is
//! Termul's own save, whatever path it names. An export with a `path` runs
//! without it, so the bytes come back inline, and Termul writes them to that
//! path only when it lies inside the project. The editor picks an export's
//! format from the path's extension when none is given, so without the path
//! Termul names the format itself. Every other command or method that reads
//! or writes a path is refused with `UNSUPPORTED_IN_KIOSK`.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::acp::host_mcp::canvas::{CanvasError, CanvasErrorCode};

/// Where the parent sends one canvas call.
#[derive(Debug, Clone, PartialEq)]
pub enum CanvasRoute {
    /// To the editor unchanged.
    Forward,
    /// `host.save` on the renderer instead of the editor's own save.
    HostSave,
    /// `execute` (the export without its `path`) to the editor, then Termul
    /// writes the returned bytes to `path`.
    ExportTo {
        path: String,
        execute: Value,
    },
    Refuse(CanvasError),
}

/// When a command or method reaches the file system.
#[derive(Clone, Copy)]
enum FileArg {
    Always,
    /// A string param with this name is a file path.
    Path(&'static str),
    /// `variables` is a path when it is a string that is not JSON text.
    VariablesPath,
}

#[derive(Clone, Copy)]
enum CommandPolicy {
    HostSave,
    ExportTo,
    Refuse(&'static [FileArg]),
}

const ALWAYS: &[FileArg] = &[FileArg::Always];
const PATH: &[FileArg] = &[FileArg::Path("path")];

/// figcraft engine commands that name files (`crates/engine/src/cmd`).
const COMMANDS: &[(&str, CommandPolicy)] = &[
    ("file.save", CommandPolicy::HostSave),
    ("file.export", CommandPolicy::ExportTo),
    ("file.exportSvg", CommandPolicy::ExportTo),
    ("file.exportFramesPdf", CommandPolicy::ExportTo),
    ("file.saveAs", CommandPolicy::Refuse(ALWAYS)),
    ("file.open", CommandPolicy::Refuse(ALWAYS)),
    ("file.openRecent", CommandPolicy::Refuse(ALWAYS)),
    ("file.recover", CommandPolicy::Refuse(ALWAYS)),
    ("file.revert", CommandPolicy::Refuse(ALWAYS)),
    ("library.add", CommandPolicy::Refuse(ALWAYS)),
    ("window.new", CommandPolicy::Refuse(ALWAYS)),
    (
        "file.exportLayers",
        CommandPolicy::Refuse(&[FileArg::Path("dir")]),
    ),
    (
        "file.import",
        CommandPolicy::Refuse(&[FileArg::Path("path"), FileArg::VariablesPath]),
    ),
    ("file.placeImage", CommandPolicy::Refuse(PATH)),
    ("image.place", CommandPolicy::Refuse(PATH)),
    ("variable.export", CommandPolicy::Refuse(PATH)),
    (
        "variable.import",
        CommandPolicy::Refuse(&[FileArg::VariablesPath]),
    ),
];

/// Control methods other than `engine.execute` that can name a file.
const METHODS: &[(&str, &[FileArg])] = &[("ui.render", PATH), ("ui.screenshot", PATH)];

const EXECUTE: &str = "engine.execute";
const EXPORT: &str = "file.export";
const BATCH: &str = "command.batch";

/// Route one call. `params` is the call's parsed params.
#[must_use]
pub fn route(method: &str, params: &Value) -> CanvasRoute {
    if method == EXECUTE {
        return route_execute(params);
    }
    match METHODS.iter().find(|(name, _)| *name == method) {
        Some((_, args)) if touches_files(args, params) => CanvasRoute::Refuse(unsupported(method)),
        _ => CanvasRoute::Forward,
    }
}

fn route_execute(execute: &Value) -> CanvasRoute {
    let Some(command) = execute.get("command").and_then(Value::as_str) else {
        return CanvasRoute::Forward;
    };
    let params = execute.get("params").unwrap_or(&Value::Null);
    if command == BATCH {
        return route_batch(params);
    }
    match COMMANDS.iter().find(|(name, _)| *name == command) {
        None => CanvasRoute::Forward,
        Some((_, CommandPolicy::HostSave)) => CanvasRoute::HostSave,
        Some((_, CommandPolicy::ExportTo)) => match string_param(params, "path") {
            None => CanvasRoute::Forward,
            Some(path) => {
                let mut execute = execute.clone();
                if let Some(params) = execute.get_mut("params").and_then(Value::as_object_mut) {
                    params.remove("path");
                    let unnamed = params.get("format").and_then(Value::as_str).is_none();
                    if command == EXPORT && unnamed {
                        let Some(format) = export_format(path) else {
                            return CanvasRoute::Refuse(unknown_format(path));
                        };
                        params.insert("format".to_string(), Value::from(format));
                    }
                }
                CanvasRoute::ExportTo {
                    path: path.to_string(),
                    execute,
                }
            }
        },
        Some((_, CommandPolicy::Refuse(args))) if touches_files(args, params) => {
            CanvasRoute::Refuse(unsupported(command))
        }
        Some((_, CommandPolicy::Refuse(_))) => CanvasRoute::Forward,
    }
}

/// A batch runs as one undo step inside the editor, so a step Termul would
/// have to handle itself refuses the whole batch.
fn route_batch(params: &Value) -> CanvasRoute {
    let steps = params
        .get("commands")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for (index, step) in steps.iter().enumerate() {
        if route_execute(step) != CanvasRoute::Forward {
            let command = step.get("command").and_then(Value::as_str).unwrap_or("?");
            return CanvasRoute::Refuse(CanvasError::new(
                CanvasErrorCode::UnsupportedInKiosk,
                format!(
                    "batch step {index} (`{command}`) saves or touches files; run it on its own \
                     (save_file saves, export returns bytes or writes inside the project)"
                ),
            ));
        }
    }
    CanvasRoute::Forward
}

fn touches_files(args: &[FileArg], params: &Value) -> bool {
    args.iter().any(|arg| match arg {
        FileArg::Always => true,
        FileArg::Path(name) => string_param(params, name).is_some(),
        FileArg::VariablesPath => string_param(params, "variables")
            .is_some_and(|text| serde_json::from_str::<Value>(text).is_err()),
    })
}

fn string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str)
}

/// The format the editor would read from `path`'s extension (figcraft
/// `ExportFormat::from_ext`, plus `fig` for the whole file).
fn export_format(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "svg" => Some("svg"),
        "webp" => Some("webp"),
        "pdf" => Some("pdf"),
        "fig" => Some("fig"),
        _ => None,
    }
}

fn unknown_format(path: &str) -> CanvasError {
    CanvasError::new(
        CanvasErrorCode::EngineError,
        format!(
            "export cannot tell the format of `{path}`: give it a png, jpg, svg, webp, pdf or \
             fig extension, or pass `format`"
        ),
    )
}

fn unsupported(name: &str) -> CanvasError {
    CanvasError::new(
        CanvasErrorCode::UnsupportedInKiosk,
        format!(
            "`{name}` reads or writes files, which the Termul canvas does not allow: save_file \
             saves the project's document, and export returns bytes or writes inside the project"
        ),
    )
}

/// A file inside the project an export may write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFile {
    pub absolute: PathBuf,
    /// `/`-separated, relative to the project root.
    pub relative: String,
}

/// A path part Windows would not treat as a plain file: an alternate data
/// stream (`a.png:x`) or a reserved device name (`CON`, `nul.txt`, `COM1`),
/// which Windows matches on the part before the first dot, ignoring case and
/// trailing spaces. Refused on every platform so a project behaves the same
/// wherever its host runs.
fn names_a_stream_or_device(part: &str) -> bool {
    if part.contains(':') {
        return true;
    }
    let stem = part.split('.').next().unwrap_or(part).trim_end_matches(' ');
    let stem = stem.to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            let mut chars = rest.chars();
            matches!(
                (chars.next(), chars.next()),
                (Some('0'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'), None)
            )
        })
    };
    numbered("COM") || numbered("LPT")
}

/// Why an export path is refused. Each reason names its own cause so the
/// agent can tell what to change.
#[derive(Debug)]
enum PathRefusal {
    NoFile,
    Absolute,
    ClimbsWithDotDot,
    StreamOrDevice {
        part: String,
    },
    /// `link` (`/`-separated, from the root) is the first part that resolves
    /// outside the project, to `target`.
    LinkOutside {
        link: String,
        target: PathBuf,
    },
    /// `part` exists but could not be resolved, such as a dangling link.
    Unresolvable {
        part: String,
        error: std::io::Error,
    },
    /// Resolved outside the project although no single part does now: the
    /// folders changed between the check and the diagnosis.
    ResolvesOutside,
}

impl PathRefusal {
    fn into_error(self, requested: &str) -> CanvasError {
        let message = match self {
            Self::NoFile => {
                format!("export needs a file path inside the project; `{requested}` names no file")
            }
            Self::Absolute => format!(
                "export writes only to a path relative to the project folder; `{requested}` is \
                 absolute or starts at a drive or root"
            ),
            Self::ClimbsWithDotDot => format!(
                "export does not follow `..`; name `{requested}` from the project folder down \
                 without it"
            ),
            Self::StreamOrDevice { part } => format!(
                "export does not write to `{requested}`: `{part}` names a Windows stream or device"
            ),
            Self::LinkOutside { link, target } => format!(
                "export writes only inside the project; in `{requested}`, `{link}` is a link to \
                 `{}`, which is outside the project; export to a folder inside the project instead",
                crate::path_validation::strip_verbatim_prefix(&target.to_string_lossy())
            ),
            Self::Unresolvable { part, error } => format!(
                "export cannot tell whether `{part}` in `{requested}` stays inside the project: {error}"
            ),
            Self::ResolvesOutside => format!(
                "export writes only inside the project; `{requested}` resolves outside it"
            ),
        };
        CanvasError::new(CanvasErrorCode::UnsupportedInKiosk, message)
    }
}

/// Name the first of `parts`, walked down from the canonical `root`, that
/// resolves outside it. Only explains a refusal already decided.
fn escaping_part(root: &Path, parts: &[String]) -> PathRefusal {
    let mut path = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let named = parts[..=index].join("/");
        match std::fs::canonicalize(&path) {
            Ok(resolved) if resolved.starts_with(root) => {}
            Ok(target) => {
                return PathRefusal::LinkOutside {
                    link: named,
                    target,
                }
            }
            Err(_) if path.symlink_metadata().is_err() => break,
            Err(error) => return PathRefusal::Unresolvable { part: named, error },
        }
    }
    PathRefusal::ResolvesOutside
}

/// Check `requested` names a file inside `root`: relative, no `..`, no
/// stream or device name, and no existing part of it a link that resolves
/// outside the root.
pub fn resolve_project_file(root: &Path, requested: &str) -> Result<ProjectFile, CanvasError> {
    let refuse = |reason: PathRefusal| reason.into_error(requested);
    let mut parts = Vec::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy().into_owned();
                if names_a_stream_or_device(&part) {
                    return Err(refuse(PathRefusal::StreamOrDevice { part }));
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(refuse(PathRefusal::ClimbsWithDotDot)),
            Component::RootDir | Component::Prefix(_) => return Err(refuse(PathRefusal::Absolute)),
        }
    }
    if parts.is_empty() {
        return Err(refuse(PathRefusal::NoFile));
    }
    let root = std::fs::canonicalize(root).map_err(|error| {
        CanvasError::new(
            CanvasErrorCode::EngineError,
            format!("the project folder is unavailable: {error}"),
        )
    })?;
    let absolute = parts
        .iter()
        .fold(root.clone(), |path, part| path.join(part));
    let existing = absolute
        .ancestors()
        .find(|path| path.symlink_metadata().is_ok())
        .unwrap_or(&root);
    match std::fs::canonicalize(existing) {
        Ok(resolved) if resolved.starts_with(&root) => Ok(ProjectFile {
            absolute,
            relative: parts.join("/"),
        }),
        _ => Err(refuse(escaping_part(&root, &parts))),
    }
}

/// Write `bytes` to `requested` inside `root`, checking the path again right
/// before the write: a link planted since an earlier check (while the editor
/// exported) must not lead the write out of the project. The write goes
/// through the parent as it resolves after its folders exist, and the
/// folders from the root down are opened without following links so none
/// swapped for a link after the check can redirect it ([`write_in_real_folder`]).
pub fn write_project_file(
    root: &Path,
    requested: &str,
    bytes: &[u8],
) -> Result<ProjectFile, CanvasError> {
    let file = resolve_project_file(root, requested)?;
    let failed = |error: std::io::Error| {
        CanvasError::new(
            CanvasErrorCode::EngineError,
            format!("could not write `{}`: {error}", file.relative),
        )
    };
    let (Some(parent), Some(name)) = (file.absolute.parent(), file.absolute.file_name()) else {
        return Err(failed(std::io::Error::other("the path names no file")));
    };
    std::fs::create_dir_all(parent).map_err(failed)?;
    let resolved_parent = std::fs::canonicalize(parent).map_err(failed)?;
    let resolved_root = std::fs::canonicalize(root).map_err(failed)?;
    if !resolved_parent.starts_with(&resolved_root) {
        let parts: Vec<String> = file.relative.split('/').map(str::to_owned).collect();
        return Err(escaping_part(&resolved_root, &parts).into_error(requested));
    }
    write_in_real_folder(&resolved_root, &resolved_parent, name, bytes).map_err(failed)?;
    Ok(file)
}

#[cfg(windows)]
fn write_in_real_folder(
    root: &Path,
    dir: &Path,
    name: &std::ffi::OsStr,
    bytes: &[u8],
) -> std::io::Result<()> {
    let _held = hold_real_folders(root, dir)?;
    crate::acp::atomic_file::replace(&dir.join(name), bytes)
}

/// Unix lets a held folder be renamed, so the write never goes by path: it
/// names `name` inside the folder opened by [`open_real_folder`].
#[cfg(unix)]
fn write_in_real_folder(
    root: &Path,
    dir: &Path,
    name: &std::ffi::OsStr,
    bytes: &[u8],
) -> std::io::Result<()> {
    use std::os::fd::AsFd;
    let folder = open_real_folder(root, dir)?;
    crate::acp::atomic_file::replace_at(folder.as_fd(), name, bytes)
}

/// Open `root`, then each folder down to `dir` (a canonical path under it)
/// relative to the one above, refusing any that is a link now.
#[cfg(unix)]
fn open_real_folder(root: &Path, dir: &Path) -> std::io::Result<rustix::fd::OwnedFd> {
    use rustix::fs::{openat, Mode, OFlags, CWD};
    use rustix::io::Errno;
    let below = dir
        .strip_prefix(root)
        .map_err(|_| std::io::Error::other("the folder is outside the project"))?;
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut folder = openat(CWD, root, flags, Mode::empty())?;
    for part in below.components() {
        folder = openat(&folder, part.as_os_str(), flags, Mode::empty()).map_err(|error| {
            if error == Errno::LOOP || error == Errno::NOTDIR {
                std::io::Error::other("a folder on the path became a link after the check")
            } else {
                error.into()
            }
        })?;
    }
    Ok(folder)
}

/// Open `root` and each folder down to `dir` (a canonical path under it)
/// without following a link, refusing one that is a link now. Windows lets
/// nobody rename or delete a folder, or any folder above it, while a handle
/// that does not share delete access is open, so the checked path keeps
/// naming the same real folders until the handles drop.
#[cfg(windows)]
fn hold_real_folders(root: &Path, dir: &Path) -> std::io::Result<Vec<std::fs::File>> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let below = dir
        .strip_prefix(root)
        .map_err(|_| std::io::Error::other("the folder is outside the project"))?;
    let mut folder = root.to_path_buf();
    let mut held = Vec::new();
    for part in std::iter::once(None).chain(below.components().map(Some)) {
        if let Some(part) = part {
            folder.push(part);
        }
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&folder)?;
        // A symlink or junction; other reparse points (cloud files) are folders.
        if handle.metadata()?.file_type().is_symlink() {
            return Err(std::io::Error::other(
                "a folder on the path became a link after the check",
            ));
        }
        held.push(handle);
    }
    Ok(held)
}

#[cfg(test)]
mod tests;
