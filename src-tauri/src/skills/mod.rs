//! Agent Skills discovery — Zed-compatible `SKILL.md` packages under
//! `~/.agents/skills/` (global) and `{project}/.agents/skills/` (project-local).
//!
//! Surfaced to the renderer slash-command menu via `commands.rs`. The renderer
//! dedupes discovered skills against the ACP `availableCommands` so a skill the
//! agent already reports natively is not shown twice (see `slash-menu-model`).

pub mod commands;

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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
                log::warn!("failed to read file type for {}: {e}", entry.path().display());
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
        // Canonicalize the SKILL.md path so the renderer-side wire prompt can
        // cite a stable absolute path for the agent to read at prompt time.
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
pub fn list_agent_skills(project_root: Option<&str>) -> Result<Vec<AgentSkillSummary>, String> {
    log::debug!("listing agent skills, project_root={project_root:?}");
    let mut by_name: HashMap<String, AgentSkillSummary> = HashMap::new();

    scan_skills_dir(&home_skills_root()?, "global", &mut by_name)?;

    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        let project_skills = PathBuf::from(root).join(".agents").join("skills");
        scan_skills_dir(&project_skills, "project", &mut by_name)?;
    }

    let mut skills: Vec<AgentSkillSummary> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    log::debug!("listed {} agent skill(s)", skills.len());
    Ok(skills)
}

fn resolve_skill_path(name: &str, project_root: Option<&str>) -> Result<(PathBuf, String), String> {
    validate_skill_name(name)?;

    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        let project_skill = PathBuf::from(root)
            .join(".agents")
            .join("skills")
            .join(name)
            .join("SKILL.md");
        if project_skill.is_file() {
            return Ok((project_skill, "project".to_string()));
        }
    }

    let global_skill = home_skills_root()?.join(name).join("SKILL.md");
    if global_skill.is_file() {
        return Ok((global_skill, "global".to_string()));
    }

    Err(format!("skill '{name}' not found"))
}

/// Read a skill's markdown body. Project-local overrides global.
pub fn read_agent_skill(
    name: &str,
    project_root: Option<&str>,
) -> Result<AgentSkillContent, String> {
    let (path, scope) = resolve_skill_path(name, project_root).map_err(|e| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_skill_md_splits_frontmatter() {
        let raw = "---\nname: demo\ndescription: A demo skill\n---\n\n## Steps\n\nDo things.\n";
        let (fm, body) = parse_skill_md(raw).unwrap();
        assert_eq!(fm.get("name").map(String::as_str), Some("demo"));
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("A demo skill")
        );
        assert!(body.contains("## Steps"));
    }

    #[test]
    fn list_and_read_project_skill() {
        let temp = std::env::temp_dir().join(format!("termul-skill-test-{}", std::process::id()));
        let skill_dir = temp.join(".agents").join("skills").join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: Demo\n---\n\nRun the demo.\n",
        )
        .unwrap();
        let expected_skill_md = skill_dir.join("SKILL.md");

        let root = temp.to_string_lossy().to_string();
        let listed = list_agent_skills(Some(&root)).unwrap();
        let summary = listed
            .iter()
            .find(|s| s.name == "demo-skill" && s.scope == "project")
            .expect("project skill should be listed");
        // The wire prompt cites the SKILL.md path so the agent can read it from
        // disk — the scanner must surface it on the summary.
        assert_eq!(summary.path, expected_skill_md.to_string_lossy().to_string());

        let content = read_agent_skill("demo-skill", Some(&root)).unwrap();
        assert_eq!(content.name, "demo-skill");
        assert_eq!(content.body.trim(), "Run the demo.");
        assert_eq!(content.path, expected_skill_md.to_string_lossy().to_string());

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn list_and_read_global_skill_populates_path() {
        // Skills under the user's home `~/.agents/skills/<name>/SKILL.md` must
        // surface their absolute path so the wire prompt can cite a global skill
        // path (the agent reads the body from disk at prompt time).
        let home = std::env::temp_dir().join(format!("termul-skill-home-{}", std::process::id()));
        let global_root = home.join(".agents").join("skills");
        let skill_dir = global_root.join("global-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: global-skill\ndescription: Global\n---\n\nRun globally.\n",
        )
        .unwrap();
        let expected_skill_md = skill_dir.join("SKILL.md");

        let prev_home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        std::env::set_var("HOME", home.to_string_lossy().to_string());
        let result = std::panic::catch_unwind(|| {
            // No project root → only the global skill is discovered.
            let listed = list_agent_skills(None).unwrap();
            let summary = listed
                .iter()
                .find(|s| s.name == "global-skill" && s.scope == "global")
                .expect("global skill should be listed");
            assert_eq!(summary.path, expected_skill_md.to_string_lossy().to_string());

            let content = read_agent_skill("global-skill", None).unwrap();
            assert_eq!(content.scope, "global");
            assert_eq!(content.path, expected_skill_md.to_string_lossy().to_string());
        });
        // Restore HOME/USERPROFILE so other tests don't see the temp home.
        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        assert!(result.is_ok(), "global skill path population failed");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn read_agent_skill_rejects_path_traversal_names() {
        let temp = std::env::temp_dir().join(format!("termul-skill-sec-{}", std::process::id()));
        let skill_dir = temp.join(".agents").join("skills").join("safe-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: safe-skill\n---\n\nok\n",
        )
        .unwrap();
        let root = temp.to_string_lossy().to_string();

        for malicious in [
            "../../../etc/passwd",
            "foo/../bar",
            "..",
            ".",
            "bad/name",
            "bad\\name",
        ] {
            let err = read_agent_skill(malicious, Some(&root)).unwrap_err();
            assert!(
                err.contains("invalid skill name") || err.contains("not found"),
                "expected rejection for {malicious}, got: {err}"
            );
        }

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn list_agent_skills_ignores_invalid_directory_names() {
        let temp =
            std::env::temp_dir().join(format!("termul-skill-list-sec-{}", std::process::id()));
        let skills_root = temp.join(".agents").join("skills");
        fs::create_dir_all(skills_root.join("valid-skill")).unwrap();
        fs::write(
            skills_root.join("valid-skill").join("SKILL.md"),
            "---\nname: valid-skill\n---\n\nok\n",
        )
        .unwrap();
        fs::create_dir_all(skills_root.join("Invalid")).unwrap();
        fs::write(
            skills_root.join("Invalid").join("SKILL.md"),
            "---\nname: Invalid\n---\n\nno\n",
        )
        .unwrap();

        let root = temp.to_string_lossy().to_string();
        let listed = list_agent_skills(Some(&root)).unwrap();
        assert!(listed.iter().any(|s| s.name == "valid-skill"));
        assert!(!listed.iter().any(|s| s.name == "Invalid"));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn parse_skill_md_handles_empty_frontmatter() {
        // An empty frontmatter block must parse, not report "not closed".
        let (fm, body) = parse_skill_md("---\n\n---\nbody").unwrap();
        assert!(fm.is_empty());
        assert_eq!(body.trim(), "body");

        let (fm2, body2) = parse_skill_md("---\n---\n## Steps").unwrap();
        assert!(fm2.is_empty());
        assert_eq!(body2.trim(), "## Steps");
    }

    #[test]
    fn list_agent_skills_skips_malformed_skill_and_keeps_valid() {
        let temp =
            std::env::temp_dir().join(format!("termul-skip-bad-{}", std::process::id()));
        let skills_root = temp.join(".agents").join("skills");
        fs::create_dir_all(skills_root.join("good-skill")).unwrap();
        fs::write(
            skills_root.join("good-skill").join("SKILL.md"),
            "---\nname: good-skill\ndescription: ok\n---\n\nbody\n",
        )
        .unwrap();
        fs::create_dir_all(skills_root.join("bad-skill")).unwrap();
        // Unclosed frontmatter → parse_skill_md returns Err; listing must skip
        // this entry and still return the valid skill.
        fs::write(
            skills_root.join("bad-skill").join("SKILL.md"),
            "---\nname: bad-skill\nthis frontmatter never closes",
        )
        .unwrap();

        let root = temp.to_string_lossy().to_string();
        let listed = list_agent_skills(Some(&root)).unwrap();
        assert!(listed.iter().any(|s| s.name == "good-skill"));
        assert!(!listed.iter().any(|s| s.name == "bad-skill"));

        let _ = fs::remove_dir_all(temp);
    }
}
