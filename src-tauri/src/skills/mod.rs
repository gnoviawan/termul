//! Agent Skills discovery — Zed-compatible `SKILL.md` packages under
//! `~/.agents/skills/` (global) and `{project}/.agents/skills/` (project-local).
//!
//! Surfaced to the renderer slash-command menu via `commands.rs`. The renderer
//! dedupes in both directions: a skill the agent already reports natively as an
//! ACP `availableCommands` entry is not shown twice, and an agent command that
//! re-promotes a discovered skill (`skill:<name>`) is hidden in favour of the
//! injected skill item (see `slash-menu-model`).

pub mod commands;

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

fn home_skills_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "could not resolve user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".agents").join("skills"))
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
/// so tests can supply a temp home without mutating the process-wide `HOME`
/// (which would race with other tests reading `home_skills_root()`).
pub fn list_agent_skills_with_home(
    home_root: &Path,
    project_root: Option<&str>,
) -> Result<Vec<AgentSkillSummary>, String> {
    log::debug!("listing agent skills, project_root={project_root:?}");
    let mut by_name: HashMap<String, AgentSkillSummary> = HashMap::new();

    scan_skills_dir(home_root, "global", &mut by_name)?;

    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        // Reject a relative project root early: a relative path would scan the
        // process CWD (undefined for a Tauri command) rather than the intended
        // project. The renderer always passes an absolute `session.cwd`.
        let root_path = PathBuf::from(root);
        if !root_path.is_absolute() {
            return Err(format!("project root must be absolute, got: {root}"));
        }
        let project_skills = root_path.join(".agents").join("skills");
        scan_skills_dir(&project_skills, "project", &mut by_name)?;
    }

    let mut skills: Vec<AgentSkillSummary> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    log::debug!("listed {} agent skill(s)", skills.len());
    Ok(skills)
}

/// List installed skills using the real user home (`~/.agents/skills`).
pub fn list_agent_skills(project_root: Option<&str>) -> Result<Vec<AgentSkillSummary>, String> {
    list_agent_skills_with_home(&home_skills_root()?, project_root)
}

fn resolve_skill_path_with_home(
    name: &str,
    project_root: Option<&str>,
    home_root: &Path,
) -> Result<(PathBuf, String), String> {
    validate_skill_name(name)?;

    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        // Reject a relative project root before constructing skill paths (mirrors
        // the check in `list_agent_skills_with_home`).
        let root_path = PathBuf::from(root);
        if !root_path.is_absolute() {
            return Err(format!("project root must be absolute, got: {root}"));
        }
        let project_skill = root_path
            .join(".agents")
            .join("skills")
            .join(name)
            .join("SKILL.md");
        if project_skill.is_file() {
            return Ok((project_skill, "project".to_string()));
        }
    }

    let global_skill = home_root.join(name).join("SKILL.md");
    if global_skill.is_file() {
        return Ok((global_skill, "global".to_string()));
    }

    Err(format!("skill '{name}' not found"))
}

/// Read a skill's markdown body. Project-local overrides global.
///
/// `home_root` is injected (see `list_agent_skills_with_home`) so tests can
/// resolve a global skill against a temp home without mutating `HOME`.
pub fn read_agent_skill_with_home(
    name: &str,
    home_root: &Path,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    let (path, scope) =
        resolve_skill_path_with_home(name, project_root, home_root).map_err(|e| {
            log::warn!("agent skill '{name}' could not be resolved: {e}");
            e
        })?;
    let raw = fs::read_to_string(&path).map_err(|e| {
        log::warn!("failed to read skill '{}': {e}", path.display());
        format!("read {}: {e}", path.display())
    })?;
    let (frontmatter, body) = parse_skill_md(&raw)?;
    let skill_name = frontmatter
        .get("name")
        .cloned()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| name.to_string());
    let description = frontmatter.get("description").cloned().unwrap_or_default();
    let path = path.to_string_lossy().to_string();

    Ok(AgentSkillContent {
        name: skill_name,
        description,
        scope,
        body,
        path,
    })
}

/// Read a skill's markdown body using the real user home (`~/.agents/skills`).
pub fn read_agent_skill(
    name: &str,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    read_agent_skill_with_home(name, &home_skills_root()?, project_root)
}

#[cfg(test)]
mod tests;
