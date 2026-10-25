//! Agent Skills discovery — Zed-compatible `SKILL.md` packages under
//! `~/.agents/skills/` (global) and `{project}/.agents/skills/` (project-local),
//! plus Claude Code skills under `~/.claude/skills/` and enabled plugins
//! recorded in `~/.claude/plugins/installed_plugins.json` (project- and
//! local-scoped plugin installs apply only inside their own project).
//!
//! Surfaced to the renderer slash-command menu and the Settings list via
//! `commands.rs`. An installed skill stays in the menu. A harness command that
//! repeats it — the same name, or a re-promoted `skill:<name>` command — is
//! hidden. Comparison is case-insensitive (see `slash-menu-model`).

pub mod commands;
pub mod files;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSummary {
    pub name: String,
    pub description: String,
    /// `"global"` or `"project"`.
    pub scope: String,
    /// Absolute path to the skill's `SKILL.md` so the agent can read the
    /// instructions from disk at prompt time (no body is shipped over the wire).
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillContent {
    pub name: String,
    pub description: String,
    pub scope: String,
    /// Markdown body after YAML frontmatter.
    pub body: String,
    /// Absolute path to the skill's `SKILL.md`.
    pub path: String,
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "could not resolve user home directory".to_string())
}

/// Zed-compatible skill names: lowercase letters, digits, hyphens; no traversal.
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("skill name must not be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("invalid skill name".to_string());
    }
    if name == "." || name == ".." {
        return Err("invalid skill name".to_string());
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err("invalid skill name".to_string());
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("invalid skill name".to_string());
    }
    Ok(())
}

/// Split `SKILL.md` into frontmatter key/value pairs and the markdown body.
pub fn parse_skill_md(content: &str) -> Result<(HashMap<String, String>, String), String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Ok((HashMap::new(), content.trim().to_string()));
    }

    let rest = trimmed.strip_prefix("---").unwrap_or(trimmed);
    let end = rest
        .find("\n---")
        .ok_or_else(|| "SKILL.md frontmatter is not closed with '---'".to_string())?;
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\r').trim_start();

    let mut map = HashMap::new();
    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        if !key.is_empty() {
            map.insert(key, value);
        }
    }

    Ok((map, body.to_string()))
}

fn scan_skills_dir(
    dir: &Path,
    scope: &str,
    out: &mut HashMap<String, AgentSkillSummary>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("failed to read skills directory {}: {e}", dir.display());
            return Ok(());
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("failed to read a skills directory entry: {e}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                log::warn!(
                    "failed to read file type for {}: {e}",
                    entry.path().display()
                );
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }

        let raw = match fs::read_to_string(&skill_md) {
            Ok(raw) => raw,
            Err(e) => {
                log::warn!("failed to read {}: {e}", skill_md.display());
                continue;
            }
        };
        let (frontmatter, _) = match parse_skill_md(&raw) {
            Ok(parsed) => parsed,
            Err(e) => {
                log::warn!("failed to parse {}: {e}", skill_md.display());
                continue;
            }
        };
        let name = frontmatter
            .get("name")
            .cloned()
            .filter(|n| !n.is_empty())
            .unwrap_or(folder_name);
        if validate_skill_name(&name).is_err() {
            continue;
        }
        let description = frontmatter.get("description").cloned().unwrap_or_default();
        // Absolute SKILL.md path derived from the (already-absolute) scan root,
        // so the renderer-side wire prompt can cite it for the agent to read at
        // prompt time. Not canonicalized: `fs::canonicalize` would yield a
        // `\\?\`-prefixed UNC path on Windows that is ugly to cite in the wire
        // prompt, and the scan root is already absolute.
        let path = skill_md.to_string_lossy().to_string();

        out.insert(
            name.clone(),
            AgentSkillSummary {
                name,
                description,
                scope: scope.to_string(),
                path,
            },
        );
    }

    Ok(())
}

/// List installed skills. Project-local entries override global names.
///
/// `home_root` is the global skills root (`~/.agents/skills`) to scan, injected
/// so tests can supply a temp directory without mutating the process-wide `HOME`.
/// This seam does not read Claude Code directories. Production listing goes
/// through `list_agent_skills`, which passes the real `~/.claude` root.
#[cfg(test)]
pub fn list_agent_skills_with_home(
    home_root: &Path,
    project_root: Option<&str>,
) -> Result<Vec<AgentSkillSummary>, String> {
    list_agent_skills_with_roots(home_root, None, project_root)
}

/// Same listing as `list_agent_skills_with_home`, plus an optional Claude Code
/// home (`~/.claude`: `skills/`, `settings.json`, `plugins/installed_plugins.json`).
/// `None` keeps the call hermetic.
pub(crate) fn list_agent_skills_with_roots(
    agents_skills: &Path,
    claude_home: Option<&Path>,
    project_root: Option<&str>,
) -> Result<Vec<AgentSkillSummary>, String> {
    let mut skills: Vec<AgentSkillSummary> =
        discover_skills(agents_skills, claude_home, project_root)?
            .into_values()
            .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    log::debug!("listed {} agent skill(s)", skills.len());
    Ok(skills)
}

/// List installed skills using the real user home.
///
/// Scans `~/.claude` plugin and user skills, then `~/.agents/skills/`, then the
/// project `.agents/skills/` directory. A missing Claude directory is an empty
/// source, not an error.
pub fn list_agent_skills(project_root: Option<&str>) -> Result<Vec<AgentSkillSummary>, String> {
    let home = user_home()?;
    list_agent_skills_with_roots(
        &home.join(".agents").join("skills"),
        Some(&home.join(".claude")),
        project_root,
    )
}

/// Reject a relative project root before any scan. A relative path would scan
/// the process CWD (undefined for a Tauri command). The renderer always passes
/// an absolute `session.cwd`.
fn absolute_project_root(project_root: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(root) = project_root.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let root_path = PathBuf::from(root);
    if !root_path.is_absolute() {
        return Err(format!("project root must be absolute, got: {root}"));
    }
    Ok(Some(root_path))
}

fn read_text_optional(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            log::warn!("failed to read {}: {error}", path.display());
            None
        }
    }
}

/// `enabledPlugins` from one Claude settings file. Missing, unreadable, or
/// malformed JSON contributes no flags. Unknown keys are ignored. Only boolean
/// values count.
fn enabled_flags(path: &Path) -> HashMap<String, bool> {
    let Some(raw) = read_text_optional(path) else {
        return HashMap::new();
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "failed to parse Claude settings {}: {error}",
                path.display()
            );
            return HashMap::new();
        }
    };
    let Some(flags) = value
        .get("enabledPlugins")
        .and_then(|item| item.as_object())
    else {
        return HashMap::new();
    };
    flags
        .iter()
        .filter_map(|(id, flag)| flag.as_bool().map(|enabled| (id.clone(), enabled)))
        .collect()
}

fn merged_enabled_flags(claude_home: &Path, project_root: Option<&Path>) -> HashMap<String, bool> {
    let mut flags = enabled_flags(&claude_home.join("settings.json"));
    if let Some(project_root) = project_root {
        let claude = project_root.join(".claude");
        flags.extend(enabled_flags(&claude.join("settings.json")));
        flags.extend(enabled_flags(&claude.join("settings.local.json")));
    }
    flags
}

fn parse_rfc3339(stamp: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(stamp).ok()
}

/// Project- and local-scoped installs are recorded per project: they are only
/// eligible when their `projectPath` matches the active project root. User
/// scope (and unknown scope values) applies to every project. This mirrors
/// Claude Code's own record-eligibility behavior — a foreign project's record
/// never loads in another project.
fn record_applies_to_project(
    record: &serde_json::Map<String, serde_json::Value>,
    project_root: Option<&Path>,
) -> bool {
    let scope = record
        .get("scope")
        .and_then(|item| item.as_str())
        .unwrap_or("user");
    if scope != "project" && scope != "local" {
        return true;
    }
    let Some(active_root) = project_root else {
        return false;
    };
    let Some(record_root) = record
        .get("projectPath")
        .and_then(|item| item.as_str())
        .map(PathBuf::from)
    else {
        return false;
    };
    if !record_root.is_absolute() {
        return false;
    }
    same_project_root(&record_root, active_root)
}

/// Same-project check that tolerates symlinks and trailing separators: the
/// canonical forms are compared when both paths exist, otherwise the paths as
/// written.
fn same_project_root(record_root: &Path, active_root: &Path) -> bool {
    match (fs::canonicalize(record_root), fs::canonicalize(active_root)) {
        (Ok(record_canonical), Ok(active_canonical)) => record_canonical == active_canonical,
        _ => record_root == active_root,
    }
}

/// One install path per plugin id. Records whose `lastUpdated` is missing or
/// not RFC3339, or whose `installPath` is relative or not a directory, are
/// skipped. Project- and local-scoped records apply only when their
/// `projectPath` matches the active project root; user-scoped records apply
/// everywhere. The newest stamp wins. Equal stamps keep the later array
/// element.
fn chosen_plugin_installs(
    claude_home: &Path,
    project_root: Option<&Path>,
) -> Vec<(String, PathBuf)> {
    let index_path = claude_home.join("plugins").join("installed_plugins.json");
    let Some(raw) = read_text_optional(&index_path) else {
        return Vec::new();
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "failed to parse Claude plugin index {}: {error}",
                index_path.display()
            );
            return Vec::new();
        }
    };
    let Some(plugins) = value.get("plugins").and_then(|item| item.as_object()) else {
        log::warn!(
            "Claude plugin index {} has no plugins object",
            index_path.display()
        );
        return Vec::new();
    };

    let mut ids: Vec<&String> = plugins.keys().collect();
    ids.sort();
    let mut chosen = Vec::new();
    for id in ids {
        let Some(records) = plugins.get(id).and_then(|item| item.as_array()) else {
            log::warn!("Claude plugin '{id}' is not an install array; skipping");
            continue;
        };
        let mut best: Option<(chrono::DateTime<chrono::FixedOffset>, PathBuf)> = None;
        for record in records {
            let Some(record) = record.as_object() else {
                continue;
            };
            if !record_applies_to_project(record, project_root) {
                log::debug!("skipping plugin install record not applicable to the active project");
                continue;
            }
            let Some(install_path) = record.get("installPath").and_then(|item| item.as_str())
            else {
                continue;
            };
            let install_path = PathBuf::from(install_path);
            if !install_path.is_absolute() || !install_path.is_dir() {
                continue;
            }
            let Some(updated) = record
                .get("lastUpdated")
                .and_then(|item| item.as_str())
                .and_then(parse_rfc3339)
            else {
                continue;
            };
            let replace = best
                .as_ref()
                .is_none_or(|(previous, _)| updated >= *previous);
            if replace {
                best = Some((updated, install_path));
            }
        }
        if let Some((_, install_path)) = best {
            chosen.push((id.clone(), install_path));
        }
    }
    chosen
}

/// Only `.claude-plugin/plugin.json` is read. A missing, unreadable, or
/// malformed manifest is `None`; callers apply Claude Code's own defaults.
fn read_plugin_manifest(install_path: &Path) -> Option<serde_json::Value> {
    let manifest = install_path.join(".claude-plugin").join("plugin.json");
    let raw = read_text_optional(&manifest)?;
    match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(error) => {
            log::warn!(
                "failed to parse plugin manifest {}: {error}",
                manifest.display()
            );
            None
        }
    }
}

/// Missing manifest, missing field, or malformed JSON means enabled. Claude
/// Code's own default is `true`.
fn plugin_default_enabled(install_path: &Path) -> bool {
    let Some(manifest) = read_plugin_manifest(install_path) else {
        return true;
    };
    manifest
        .get("defaultEnabled")
        .and_then(|item| item.as_bool())
        .unwrap_or(true)
}

/// Skill directories the manifest's `skills` key declares in addition to the
/// default `skills/` directory: a single path or an array of paths, relative
/// to the install root. Absolute, rooted, drive-prefixed, and traversal paths
/// are skipped — a plugin must not reach outside itself.
fn manifest_skill_dirs(install_path: &Path) -> Vec<PathBuf> {
    let Some(manifest) = read_plugin_manifest(install_path) else {
        return Vec::new();
    };
    let declared: Vec<&str> = match manifest.get("skills") {
        None => return Vec::new(),
        Some(serde_json::Value::String(path)) => vec![path.as_str()],
        Some(serde_json::Value::Array(paths)) => {
            paths.iter().filter_map(|path| path.as_str()).collect()
        }
        Some(_) => {
            log::warn!(
                "plugin manifest in {} has an unsupported 'skills' field; ignoring it",
                install_path.display()
            );
            return Vec::new();
        }
    };
    let mut dirs = Vec::new();
    for path in declared {
        let candidate = Path::new(path.trim());
        if candidate.as_os_str().is_empty() {
            continue;
        }
        if candidate.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) {
            log::warn!(
                "plugin manifest in {} declares a skills path '{path}' outside the install root; skipping",
                install_path.display()
            );
            continue;
        }
        // Drop interior `.` segments (`./skills`) so surfaced skill paths stay
        // clean; `..`, rooted, drive-prefixed, and absolute forms were already
        // rejected above.
        dirs.push(
            install_path
                .join(candidate)
                .components()
                .collect::<PathBuf>(),
        );
    }
    dirs
}

fn plugin_id_skill_name(plugin_id: &str) -> &str {
    plugin_id
        .split_once('@')
        .map(|(name, _)| name)
        .unwrap_or(plugin_id)
}

/// Parse one `SKILL.md` package. The name comes from frontmatter, falling back
/// to `fallback_name` (the plugin id segment, or the package folder name).
fn skill_md_summary(skill_md: &Path, fallback_name: &str) -> Option<AgentSkillSummary> {
    if !skill_md.is_file() {
        return None;
    }
    let raw = fs::read_to_string(skill_md).ok()?;
    let (frontmatter, _) = parse_skill_md(&raw).ok()?;
    let name = frontmatter
        .get("name")
        .cloned()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    validate_skill_name(&name).ok()?;
    Some(AgentSkillSummary {
        name,
        description: frontmatter.get("description").cloned().unwrap_or_default(),
        scope: "global".to_string(),
        path: skill_md.to_string_lossy().to_string(),
    })
}

/// A plugin with no valid skill under its skill directories can still ship a
/// single root `SKILL.md`, named by the plugin id when frontmatter lacks one.
fn root_plugin_skill(install_path: &Path, plugin_id: &str) -> Option<AgentSkillSummary> {
    skill_md_summary(
        &install_path.join("SKILL.md"),
        plugin_id_skill_name(plugin_id),
    )
}

fn scan_plugin_skills(
    install_path: &Path,
    plugin_id: &str,
    out: &mut HashMap<String, AgentSkillSummary>,
) {
    let mut found = HashMap::new();
    // One directory level, same as every other skills root. Nested SKILL.md
    // files under a skill package are supporting docs, not more skills.
    scan_plugin_skill_dir(&install_path.join("skills"), &mut found);
    // The manifest's `skills` key adds directories to the default location.
    // A declared path that directly contains `SKILL.md` is a single skill
    // package; anything else is scanned as a package container.
    for dir in manifest_skill_dirs(install_path) {
        let fallback_name = dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if let Some(skill) = skill_md_summary(&dir.join("SKILL.md"), &fallback_name) {
            found.insert(skill.name.clone(), skill);
        } else {
            scan_plugin_skill_dir(&dir, &mut found);
        }
    }
    if found.is_empty() {
        if let Some(skill) = root_plugin_skill(install_path, plugin_id) {
            found.insert(skill.name.clone(), skill);
        }
    }
    out.extend(found);
}

fn scan_plugin_skill_dir(dir: &Path, found: &mut HashMap<String, AgentSkillSummary>) {
    if let Err(error) = scan_skills_dir(dir, "global", found) {
        log::warn!("failed to scan plugin skills in {}: {error}", dir.display());
    }
}

/// Later inserts win: enabled plugins (ids ascending), `~/.claude/skills`,
/// `~/.agents/skills`, then project `.agents/skills`.
fn discover_skills(
    agents_skills: &Path,
    claude_home: Option<&Path>,
    project_root: Option<&str>,
) -> Result<HashMap<String, AgentSkillSummary>, String> {
    log::debug!("listing agent skills, project_root={project_root:?}");
    let project_root = absolute_project_root(project_root)?;
    let mut by_name = HashMap::new();

    if let Some(claude_home) = claude_home {
        let flags = merged_enabled_flags(claude_home, project_root.as_deref());
        for (plugin_id, install_path) in
            chosen_plugin_installs(claude_home, project_root.as_deref())
        {
            let enabled = flags
                .get(&plugin_id)
                .copied()
                .unwrap_or_else(|| plugin_default_enabled(&install_path));
            if !enabled {
                continue;
            }
            scan_plugin_skills(&install_path, &plugin_id, &mut by_name);
        }
        scan_skills_dir(&claude_home.join("skills"), "global", &mut by_name)?;
    }

    scan_skills_dir(agents_skills, "global", &mut by_name)?;
    if let Some(project_root) = &project_root {
        scan_skills_dir(
            &project_root.join(".agents").join("skills"),
            "project",
            &mut by_name,
        )?;
    }
    Ok(by_name)
}

/// Read a skill's markdown body. Project-local overrides global.
///
/// `home_root` is injected (see `list_agent_skills_with_home`) so tests can
/// resolve a global skill against a temp home without mutating `HOME`.
/// This seam does not read Claude Code directories.
#[cfg(test)]
pub fn read_agent_skill_with_home(
    name: &str,
    home_root: &Path,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    read_agent_skill_with_roots(name, home_root, None, project_root)
}

pub(crate) fn read_agent_skill_with_roots(
    name: &str,
    agents_skills: &Path,
    claude_home: Option<&Path>,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    validate_skill_name(name)?;
    let summary = discover_skills(agents_skills, claude_home, project_root)?
        .get(name)
        .cloned()
        .ok_or_else(|| {
            log::warn!("agent skill '{name}' could not be resolved");
            format!("skill '{name}' not found")
        })?;
    let path = PathBuf::from(&summary.path);
    let raw = fs::read_to_string(&path).map_err(|error| {
        log::warn!("failed to read skill '{}': {error}", path.display());
        format!("read {}: {error}", path.display())
    })?;
    let (frontmatter, body) = parse_skill_md(&raw)?;
    let skill_name = frontmatter
        .get("name")
        .cloned()
        .filter(|skill_name| !skill_name.is_empty())
        .unwrap_or_else(|| name.to_string());
    let description = frontmatter.get("description").cloned().unwrap_or_default();

    Ok(AgentSkillContent {
        name: skill_name,
        description,
        scope: summary.scope,
        body,
        path: summary.path,
    })
}

/// Read a skill's markdown body using the real user home.
pub fn read_agent_skill(
    name: &str,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    let home = user_home()?;
    read_agent_skill_with_roots(
        name,
        &home.join(".agents").join("skills"),
        Some(&home.join(".claude")),
        project_root,
    )
}

#[cfg(test)]
mod tests;
