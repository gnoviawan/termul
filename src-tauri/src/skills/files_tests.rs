use super::*;
use std::fs;

struct TempTree(PathBuf);

impl TempTree {
    fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("termul-skill-files-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_skill(root: &Path, folder: &str, frontmatter_name: Option<&str>) -> PathBuf {
    let dir = root.join(folder);
    fs::create_dir_all(&dir).unwrap();
    let skill_md = dir.join("SKILL.md");
    let body = match frontmatter_name {
        Some(name) => format!("---\nname: {name}\ndescription: d\n---\n\nbody\n"),
        None => "no frontmatter\n".to_string(),
    };
    fs::write(&skill_md, body).unwrap();
    skill_md
}

fn path_of<'a>(entries: &'a [SkillFileEntry], name: &str) -> Option<&'a str> {
    entries
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.path.as_str())
}

#[test]
fn indexes_harness_roots_outside_the_project() {
    let tree = TempTree::new("harness");
    let home = tree.0.join("home");
    let config = home.join(".config");
    let project = tree.0.join("project");
    fs::create_dir_all(&project).unwrap();

    let agents = write_skill(
        &home.join(".agents/skills"),
        "termul-skill",
        Some("termul-skill"),
    );
    let opencode = write_skill(
        &config.join("opencode/skills"),
        "oc-skill",
        Some("oc-skill"),
    );
    let claude = write_skill(&home.join(".claude/skills"), "cl-skill", None);

    let entries = list_skill_files_with_roots(
        &[],
        Some(&home),
        Some(&config),
        Some(&project.to_string_lossy()),
    )
    .unwrap();

    assert_eq!(
        path_of(&entries, "termul-skill"),
        Some(agents.to_string_lossy().as_ref())
    );
    assert_eq!(
        path_of(&entries, "oc-skill"),
        Some(opencode.to_string_lossy().as_ref())
    );
    // No frontmatter `name`: the folder name is the skill name.
    assert_eq!(
        path_of(&entries, "cl-skill"),
        Some(claude.to_string_lossy().as_ref())
    );
}

#[test]
fn project_skill_overrides_global_skill_case_insensitively() {
    let tree = TempTree::new("override");
    let home = tree.0.join("home");
    let project = tree.0.join("project");

    write_skill(&home.join(".agents/skills"), "review", Some("review"));
    let project_skill = write_skill(&project.join(".claude/skills"), "review", Some("Review"));

    let entries =
        list_skill_files_with_roots(&[], Some(&home), None, Some(&project.to_string_lossy()))
            .unwrap();

    let matches: Vec<_> = entries
        .iter()
        .filter(|e| e.name.eq_ignore_ascii_case("review"))
        .collect();
    assert_eq!(matches.len(), 1, "one entry per name: {entries:?}");
    assert_eq!(matches[0].path, project_skill.to_string_lossy());
}

#[test]
fn termul_skill_list_comes_first() {
    let tree = TempTree::new("termul-first");
    let home = tree.0.join("home");
    let project = tree.0.join("project");
    fs::create_dir_all(&project).unwrap();
    let plugin_md = write_skill(
        &home.join(".claude/plugins/cache/acme/tools/1.0.0/skills"),
        "deploy",
        Some("deploy"),
    );
    write_skill(&project.join(".opencode/skills"), "deploy", Some("deploy"));
    let harness_only = write_skill(&project.join(".opencode/skills"), "lint", Some("lint"));
    let termul_skills = vec![AgentSkillSummary {
        name: "Deploy".to_string(),
        description: "d".to_string(),
        scope: "global".to_string(),
        path: plugin_md.to_string_lossy().to_string(),
    }];

    let entries = list_skill_files_with_roots(
        &termul_skills,
        Some(&home),
        None,
        Some(&project.to_string_lossy()),
    )
    .unwrap();

    let deploy: Vec<_> = entries
        .iter()
        .filter(|e| e.name.eq_ignore_ascii_case("deploy"))
        .collect();
    assert_eq!(deploy.len(), 1, "one entry per name: {entries:?}");
    assert_eq!(deploy[0].path, plugin_md.to_string_lossy());
    assert_eq!(
        path_of(&entries, "lint"),
        Some(harness_only.to_string_lossy().as_ref())
    );
}

#[test]
fn walks_up_from_a_nested_project_to_the_git_root() {
    let tree = TempTree::new("walk");
    let repo = tree.0.join("repo");
    let nested = repo.join("packages").join("app");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&nested).unwrap();
    let repo_skill = write_skill(
        &repo.join(".opencode/skills"),
        "repo-skill",
        Some("repo-skill"),
    );
    // Above the git root: must not be indexed.
    write_skill(
        &tree.0.join(".agents/skills"),
        "outside-skill",
        Some("outside-skill"),
    );

    let entries =
        list_skill_files_with_roots(&[], None, None, Some(&nested.to_string_lossy())).unwrap();

    assert_eq!(
        path_of(&entries, "repo-skill"),
        Some(repo_skill.to_string_lossy().as_ref())
    );
    assert!(path_of(&entries, "outside-skill").is_none());
}

#[test]
fn without_a_git_root_only_the_project_dir_is_searched() {
    let tree = TempTree::new("nogit");
    let project = tree.0.join("project");
    fs::create_dir_all(&project).unwrap();
    write_skill(
        &tree.0.join(".agents/skills"),
        "parent-skill",
        Some("parent-skill"),
    );
    let own = write_skill(
        &project.join(".agents/skills"),
        "own-skill",
        Some("own-skill"),
    );

    let entries =
        list_skill_files_with_roots(&[], None, None, Some(&project.to_string_lossy())).unwrap();

    assert_eq!(
        path_of(&entries, "own-skill"),
        Some(own.to_string_lossy().as_ref())
    );
    assert!(path_of(&entries, "parent-skill").is_none());
}

#[test]
fn skips_folders_without_skill_md() {
    let tree = TempTree::new("skip");
    let home = tree.0.join("home");
    fs::create_dir_all(home.join(".agents/skills/empty")).unwrap();
    fs::write(home.join(".agents/skills/stray.md"), "x").unwrap();

    let entries = list_skill_files_with_roots(&[], Some(&home), None, None).unwrap();

    assert!(entries.is_empty(), "{entries:?}");
}

#[test]
fn rejects_a_relative_project_root() {
    let err = list_skill_files_with_roots(&[], None, None, Some("relative/path")).unwrap_err();
    assert!(err.contains("must be absolute"), "{err}");
}
