//! Skill file index — maps every skill name an agent can load to its
//! `SKILL.md`, so chat chips (skill pills and skill-backed slash commands) can
//! open the file in the editor.
//!
//! Termul's own skill list (`list_agent_skills`: the `.agents/skills` roots
//! and Claude Code user and plugin skills) comes first, so a skill chip opens
//! the same file the slash menu cited. Harnesses also publish skills from
//! their own roots as slash commands (OpenCode turns every discovered skill
//! into a command), so this index adds those roots after it. Project roots
//! come before global roots; the first source that names a skill wins. Names
//! compare case-insensitively, like the slash menu.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use super::{list_agent_skills, parse_skill_md, AgentSkillSummary};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    pub name: String,
    /// Absolute path to the skill's `SKILL.md`.
    pub path: String,
}

/// Skill folders under a project directory, in lookup order.
const PROJECT_SKILL_DIRS: &[&str] = &[
    ".agents/skills",
    ".opencode/skills",
    ".opencode/skill",
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".gemini/skills",
];

/// Skill folders under the XDG config dir (`~/.config` by default).
const CONFIG_SKILL_DIRS: &[&str] = &["opencode/skills", "opencode/skill"];

/// Skill folders under the user home, searched after `~/.agents/skills` and
/// the config dirs.
const HOME_HARNESS_SKILL_DIRS: &[&str] = &[
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".gemini/skills",
];

/// Upper bound for the walk from the project root to its git root.
const MAX_ANCESTOR_DEPTH: usize = 32;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn config_dir(home: Option<&Path>) -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| h.join(".config")))
}

/// The project directory and its ancestors up to (and including) the first
/// one that holds `.git` — the same walk OpenCode does from its cwd. Without a
/// git root above, only the project directory itself is searched.
fn project_dirs(project_root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in project_root.ancestors().take(MAX_ANCESTOR_DEPTH) {
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            return dirs;
        }
    }
    vec![project_root.to_path_buf()]
}

fn skill_name(skill_md: &Path, folder_name: String) -> String {
    fs::read_to_string(skill_md)
        .ok()
        .and_then(|raw| parse_skill_md(&raw).ok())
        .and_then(|(frontmatter, _)| frontmatter.get("name").cloned())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or(folder_name)
}

fn index_skills_dir(dir: &Path, seen: &mut HashSet<String>, out: &mut Vec<SkillFileEntry>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("skill index: failed to read {}: {e}", dir.display());
            return;
        }
    };
    let mut skill_dirs: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    skill_dirs.sort();
    for skill_dir in skill_dirs {
        let skill_md = skill_dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(folder_name) = skill_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
        else {
            continue;
        };
        let name = skill_name(&skill_md, folder_name);
        if seen.insert(name.to_lowercase()) {
            out.push(SkillFileEntry {
                name,
                path: skill_md.to_string_lossy().to_string(),
            });
        }
    }
}

/// Index every skill `SKILL.md` visible from `project_root`.
///
/// `termul_skills` is Termul's own skill list for the same root. `home` and
/// `config_home` are injected so tests can use temp dirs without mutating the
/// process-wide `HOME` / `XDG_CONFIG_HOME`.
pub fn list_skill_files_with_roots(
    termul_skills: &[AgentSkillSummary],
    home: Option<&Path>,
    config_home: Option<&Path>,
    project_root: Option<&str>,
) -> Result<Vec<SkillFileEntry>, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        let root_path = PathBuf::from(root);
        if !root_path.is_absolute() {
            return Err(format!("project root must be absolute, got: {root}"));
        }
        for dir in project_dirs(&root_path) {
            roots.extend(PROJECT_SKILL_DIRS.iter().map(|rel| dir.join(rel)));
        }
    }
    if let Some(home) = home {
        roots.push(home.join(".agents").join("skills"));
    }
    if let Some(config) = config_home {
        roots.extend(CONFIG_SKILL_DIRS.iter().map(|rel| config.join(rel)));
    }
    if let Some(home) = home {
        roots.extend(HOME_HARNESS_SKILL_DIRS.iter().map(|rel| home.join(rel)));
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for skill in termul_skills {
        if seen.insert(skill.name.to_lowercase()) {
            entries.push(SkillFileEntry {
                name: skill.name.clone(),
                path: skill.path.clone(),
            });
        }
    }
    for root in &roots {
        index_skills_dir(root, &mut seen, &mut entries);
    }
    log::debug!(
        "skill index: {} skill file(s) across {} root(s), project_root={project_root:?}",
        entries.len(),
        roots.len()
    );
    Ok(entries)
}

/// Index skill files using the real user home and config dirs. A failed
/// Termul skill listing degrades to the harness roots only.
pub fn list_skill_files(project_root: Option<&str>) -> Result<Vec<SkillFileEntry>, String> {
    let termul_skills = list_agent_skills(project_root).unwrap_or_else(|e| {
        log::warn!("skill index: Termul skill listing failed, using harness roots only: {e}");
        Vec::new()
    });
    let home = home_dir();
    let config = config_dir(home.as_deref());
    list_skill_files_with_roots(
        &termul_skills,
        home.as_deref(),
        config.as_deref(),
        project_root,
    )
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
