//! The kiosk file-tool policy (spine AD-18), applied by the parent to every
//! canvas call before it reaches a renderer.
//!
//! The editor never touches the file system for an agent. `file.save` is
//! Termul's own save, whatever path it names. An export with a `path` runs
//! without it, so the bytes come back inline, and Termul writes them to that
//! path only when it lies inside the project. Every other command or method
//! that reads or writes a path is refused with `UNSUPPORTED_IN_KIOSK`.

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

/// Check `requested` names a file inside `root`: relative, no `..`, no
/// stream or device name, and no existing part of it a link that resolves
/// outside the root.
pub fn resolve_project_file(root: &Path, requested: &str) -> Result<ProjectFile, CanvasError> {
    let outside = || {
        CanvasError::new(
            CanvasErrorCode::UnsupportedInKiosk,
            format!(
                "export writes only to a relative path inside the project; `{requested}` is not one"
            ),
        )
    };
    let mut parts = Vec::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy().into_owned();
                if names_a_stream_or_device(&part) {
                    return Err(CanvasError::new(
                        CanvasErrorCode::UnsupportedInKiosk,
                        format!(
                            "export does not write to `{requested}`: `{part}` names a Windows stream or device"
                        ),
                    ));
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(outside())
            }
        }
    }
    if parts.is_empty() {
        return Err(outside());
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
        _ => Err(outside()),
    }
}

#[cfg(test)]
mod tests;
