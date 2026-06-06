//! Agent Skills discovery — Zed-compatible `SKILL.md` packages under
//! `~/.agents/skills/` (global) and `{project}/.agents/skills/` (project-local).

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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillContent {
    pub name: String,
    pub description: String,
    pub scope: String,
    /// Markdown body after YAML frontmatter.
    pub body: String,
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

    let rest = trimmed.strip_prefix("---").unwrap_or(trimmed).trim_start();
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
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
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

    for entry in fs::read_dir(dir).map_err(|e| format!("read skills dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }

        let raw = fs::read_to_string(&skill_md)
            .map_err(|e| format!("read {}: {e}", skill_md.display()))?;
        let (frontmatter, _) = parse_skill_md(&raw)?;
        let name = frontmatter
            .get("name")
            .cloned()
            .filter(|n| !n.is_empty())
            .unwrap_or(folder_name);
        if validate_skill_name(&name).is_err() {
            continue;
        }
        let description = frontmatter.get("description").cloned().unwrap_or_default();

        out.insert(
            name.clone(),
            AgentSkillSummary {
                name,
                description,
                scope: scope.to_string(),
            },
        );
    }

    Ok(())
}

/// List installed skills. Project-local entries override global names.
pub fn list_agent_skills(project_root: Option<&str>) -> Result<Vec<AgentSkillSummary>, String> {
    let mut by_name: HashMap<String, AgentSkillSummary> = HashMap::new();

    scan_skills_dir(&home_skills_root()?, "global", &mut by_name)?;

    if let Some(root) = project_root.filter(|s| !s.is_empty()) {
        let project_skills = PathBuf::from(root)
            .join(".agents")
            .join("skills");
        scan_skills_dir(&project_skills, "project", &mut by_name)?;
    }

    let mut skills: Vec<AgentSkillSummary> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
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
pub fn read_agent_skill(name: &str, project_root: Option<&str>) -> Result<AgentSkillContent, String> {
    let (path, scope) = resolve_skill_path(name, project_root)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let (frontmatter, body) = parse_skill_md(&raw)?;
    let skill_name = frontmatter
        .get("name")
        .cloned()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| name.to_string());
    let description = frontmatter.get("description").cloned().unwrap_or_default();

    Ok(AgentSkillContent {
        name: skill_name,
        description,
        scope,
        body,
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
        assert_eq!(fm.get("description").map(String::as_str), Some("A demo skill"));
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

        let root = temp.to_string_lossy().to_string();
        let listed = list_agent_skills(Some(&root)).unwrap();
        assert!(listed.iter().any(|s| s.name == "demo-skill" && s.scope == "project"));

        let content = read_agent_skill("demo-skill", Some(&root)).unwrap();
        assert_eq!(content.name, "demo-skill");
        assert_eq!(content.body.trim(), "Run the demo.");

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn read_agent_skill_rejects_path_traversal_names() {
        let temp = std::env::temp_dir().join(format!("termul-skill-sec-{}", std::process::id()));
        let skill_dir = temp.join(".agents").join("skills").join("safe-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: safe-skill\n---\n\nok\n").unwrap();
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
        let temp = std::env::temp_dir().join(format!("termul-skill-list-sec-{}", std::process::id()));
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
}
