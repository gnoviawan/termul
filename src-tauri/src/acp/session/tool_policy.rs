//! Host answers to a headless session's permission requests.
//!
//! A headless session (an automation's agent node) has nobody to ask, so the
//! host answers each `session/request_permission` from the session's
//! [`ToolAllowlist`]: a listed tool kind gets the agent's allow-once option,
//! anything else its reject-once option. The host never picks an
//! allow-always option (it writes a lasting rule into the agent's settings)
//! and never allows a mode switch, so the session cannot leave the mode the
//! host checked at start.
//!
//! A file tool (read, search, edit, delete, move) is allowed only when every
//! path it names is inside the session's working directory and none is a
//! protected path: version control, agent or editor config, or an env file.
//! Writing those runs code later, and reading an env file reads secrets.
//!
//! Claude Code itself reads inside its cwd without asking, so a Claude
//! session also gets only the built-in tools its allowlist names, and deny
//! rules for the protected paths (`manager::gates::with_headless_options`).
//!
//! Claude's adapter sends the kind and the paths only on the `tool_call`
//! update that precedes the request, so both are kept here per tool call. A
//! request whose kind the host never saw is refused.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, SelectedPermissionOutcome,
    ToolCallUpdate, ToolKind,
};

/// The tool kinds a headless session may use without asking anyone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolAllowlist {
    kinds: Vec<ToolKind>,
}

impl ToolAllowlist {
    /// `SwitchMode` is dropped: a session never changes its own mode.
    pub fn new(kinds: impl IntoIterator<Item = ToolKind>) -> Self {
        let mut allowed = Vec::new();
        for kind in kinds {
            if kind != ToolKind::SwitchMode && !allowed.contains(&kind) {
                allowed.push(kind);
            }
        }
        Self { kinds: allowed }
    }

    pub fn allows(&self, kind: ToolKind) -> bool {
        self.kinds.contains(&kind)
    }
}

/// Directory names a headless agent may not touch at any depth: version
/// control, agent, editor and git-hook config. Compared lowercase.
pub(crate) const PROTECTED_DIRS: [&str; 11] = [
    ".git", ".github", ".husky", ".claude", ".codex", ".gemini", ".cursor", ".agents", ".vscode",
    ".idea", ".termul",
];
/// File names a headless agent may not touch, besides `.env*`. Compared
/// lowercase.
pub(crate) const PROTECTED_FILES: [&str; 3] = [".mcp.json", ".npmrc", ".netrc"];

/// The host's answer to one permission request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolDecision {
    /// `None` when neither the request nor an earlier update named it.
    pub kind: Option<ToolKind>,
    pub allowed: bool,
    pub outcome: RequestPermissionOutcome,
}

#[derive(Default)]
pub(super) struct ToolPolicies {
    sessions: HashMap<String, SessionPolicy>,
}

struct SessionPolicy {
    allowlist: ToolAllowlist,
    calls: HashMap<String, SeenCall>,
}

#[derive(Default)]
struct SeenCall {
    kind: Option<ToolKind>,
    paths: Vec<PathBuf>,
}

impl ToolPolicies {
    pub(super) fn set(&mut self, session_id: String, allowlist: ToolAllowlist) {
        self.sessions.insert(
            session_id,
            SessionPolicy {
                allowlist,
                calls: HashMap::new(),
            },
        );
    }

    pub(super) fn forget(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// Record what a `tool_call` or `tool_call_update` said about a call.
    /// Fields an update leaves out keep their earlier value.
    pub(super) fn note_call(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        kind: Option<ToolKind>,
        paths: Option<Vec<PathBuf>>,
    ) {
        let Some(policy) = self.sessions.get_mut(session_id) else {
            return;
        };
        let seen = policy.calls.entry(tool_call_id.to_string()).or_default();
        if kind.is_some() {
            seen.kind = kind;
        }
        if let Some(paths) = paths {
            seen.paths = paths;
        }
    }

    /// `None` when the session has no allowlist. `root` is the session's
    /// canonical working directory.
    pub(super) fn answer(
        &self,
        session_id: &str,
        root: Option<&Path>,
        tool_call: &ToolCallUpdate,
        options: &[PermissionOption],
    ) -> Option<ToolDecision> {
        let policy = self.sessions.get(session_id)?;
        let seen = policy.calls.get(tool_call.tool_call_id.0.as_ref());
        let kind = tool_call.fields.kind.or_else(|| seen.and_then(|s| s.kind));
        let paths: Vec<&Path> = match &tool_call.fields.locations {
            Some(locations) if !locations.is_empty() => {
                locations.iter().map(|l| l.path.as_path()).collect()
            }
            _ => seen
                .map(|s| s.paths.iter().map(PathBuf::as_path).collect())
                .unwrap_or_default(),
        };
        let permitted = kind.is_some_and(|kind| {
            policy.allowlist.allows(kind) && (!is_file_kind(kind) || paths_permitted(root, &paths))
        });
        let allow_once = options
            .iter()
            .find(|o| o.kind == PermissionOptionKind::AllowOnce);
        let reject_once = options
            .iter()
            .find(|o| o.kind == PermissionOptionKind::RejectOnce);
        let (allowed, option) = match (permitted, allow_once) {
            (true, Some(option)) => (true, Some(option)),
            _ => (false, reject_once),
        };
        let outcome = option.map_or(RequestPermissionOutcome::Cancelled, |o| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(o.option_id.clone()))
        });
        Some(ToolDecision {
            kind,
            allowed,
            outcome,
        })
    }
}

fn is_file_kind(kind: ToolKind) -> bool {
    matches!(
        kind,
        ToolKind::Read | ToolKind::Search | ToolKind::Edit | ToolKind::Delete | ToolKind::Move
    )
}

/// At least one path, and every one inside `root` and not protected.
fn paths_permitted(root: Option<&Path>, paths: &[&Path]) -> bool {
    let Some(root) = root else {
        return false;
    };
    !paths.is_empty() && paths.iter().all(|path| path_permitted(root, path))
}

fn path_permitted(root: &Path, path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(resolved) = resolve(root, path) else {
        return false;
    };
    let Ok(inside) = resolved.strip_prefix(root) else {
        return false;
    };
    inside.components().all(|component| {
        let Component::Normal(name) = component else {
            return true;
        };
        // Case-insensitive file systems (macOS, Windows) open `.Claude` as
        // `.claude`, and Windows drops trailing dots and spaces.
        let name = name
            .to_string_lossy()
            .trim_end_matches(['.', ' '])
            .to_ascii_lowercase();
        !PROTECTED_DIRS.contains(&name.as_str())
            && !PROTECTED_FILES.contains(&name.as_str())
            && !name.starts_with(".env")
    })
}

/// `path` made absolute against `root`, with `.` and `..` folded and the
/// deepest existing ancestor canonicalized, so a symlink cannot lead out.
fn resolve(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut lexical = PathBuf::new();
    for component in root.join(path).components() {
        match component {
            Component::ParentDir => {
                if !lexical.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => lexical.push(other),
        }
    }
    let mut existing = lexical.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(canonical) = existing.canonicalize() {
            return Some(rest.iter().rev().fold(canonical, |p, c| p.join(c)));
        }
        rest.push(existing.file_name()?.to_owned());
        existing = existing.parent()?;
    }
}

#[cfg(test)]
#[path = "tool_policy_tests.rs"]
mod tests;
