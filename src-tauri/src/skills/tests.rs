use super::*;
use std::fs;
use std::path::{Path, PathBuf};

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
    assert_eq!(
        summary.path,
        expected_skill_md.to_string_lossy().to_string()
    );

    let content = read_agent_skill("demo-skill", Some(&root)).unwrap();
    assert_eq!(content.name, "demo-skill");
    assert_eq!(content.body.trim(), "Run the demo.");
    assert_eq!(
        content.path,
        expected_skill_md.to_string_lossy().to_string()
    );

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

    // Inject the temp skills root directly via the `_with_home` variants
    // instead of mutating the process-wide `HOME` (which would race with
    // any other test reading `home_skills_root()`).
    let listed = list_agent_skills_with_home(&global_root, None).unwrap();
    let summary = listed
        .iter()
        .find(|s| s.name == "global-skill" && s.scope == "global")
        .expect("global skill should be listed");
    assert_eq!(
        summary.path,
        expected_skill_md.to_string_lossy().to_string()
    );

    let content = read_agent_skill_with_home("global-skill", &global_root, None).unwrap();
    assert_eq!(content.scope, "global");
    assert_eq!(
        content.path,
        expected_skill_md.to_string_lossy().to_string()
    );

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
    let temp = std::env::temp_dir().join(format!("termul-skip-bad-{}", std::process::id()));
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

fn skill_doc(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {name} skill\n---\n\n{body}\n")
}

fn write_skill(dir: &Path, name: &str, body: &str) -> PathBuf {
    let skill_dir = dir.join(name);
    fs::create_dir_all(&skill_dir).unwrap();
    let path = skill_dir.join("SKILL.md");
    fs::write(&path, skill_doc(name, body)).unwrap();
    path
}

fn write_raw_skill(dir: &Path, raw: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join("SKILL.md");
    fs::write(&path, raw).unwrap();
    path
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "termul-claude-{label}-{}-{nanos}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_installed(claude: &Path, plugins: serde_json::Value) {
    let path = claude.join("plugins").join("installed_plugins.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let body = serde_json::json!({
        "version": 2,
        "plugins": plugins
    });
    fs::write(path, serde_json::to_string(&body).unwrap()).unwrap();
}

fn install_record(path: &Path, updated: Option<&str>) -> serde_json::Value {
    let mut record = serde_json::json!({
        "scope": "user",
        "installPath": path.to_string_lossy(),
        "version": "1.0.0",
        "gitCommitSha": "abc"
    });
    if let Some(updated) = updated {
        record["lastUpdated"] = serde_json::Value::String(updated.to_string());
    }
    record
}

fn write_enabled(path: &Path, enabled: serde_json::Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let body = serde_json::json!({
        "theme": "dark",
        "skillOverrides": { "kept": true },
        "enabledPlugins": enabled
    });
    fs::write(path, serde_json::to_string(&body).unwrap()).unwrap();
}

fn write_manifest(install: &Path, default_enabled: Option<bool>) {
    let path = install.join(".claude-plugin").join("plugin.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut manifest = serde_json::json!({ "name": "demo" });
    if let Some(value) = default_enabled {
        manifest["defaultEnabled"] = serde_json::Value::Bool(value);
    }
    fs::write(path, serde_json::to_string(&manifest).unwrap()).unwrap();
}

fn listed_names(skills: &[AgentSkillSummary]) -> Vec<&str> {
    skills.iter().map(|skill| skill.name.as_str()).collect()
}

#[test]
fn claude_standalone_skill_is_listed_with_original_path() {
    let scratch = Scratch::new("standalone");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let path = write_skill(&claude.join("skills"), "claude-user", "from claude");

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let summary = listed
        .iter()
        .find(|skill| skill.name == "claude-user")
        .expect("claude skill should be listed");
    assert_eq!(summary.scope, "global");
    assert_eq!(summary.description, "claude-user skill");
    assert_eq!(summary.path, path.to_string_lossy().to_string());
}

#[test]
fn enabled_plugin_skill_is_listed_without_nested_skills() {
    let scratch = Scratch::new("plugin-on");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let install = scratch.path().join("install");
    let path = write_skill(&install.join("skills"), "plugin-skill", "from plugin");
    write_raw_skill(
        &install.join("skills").join("plugin-skill").join("nested"),
        &skill_doc("nested-skill", "nope"),
    );
    write_manifest(&install, None);
    write_installed(
        &claude,
        serde_json::json!({
            "plugin-skill@market": [install_record(&install, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );
    write_enabled(
        &claude.join("settings.json"),
        serde_json::json!({ "plugin-skill@market": true }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let summary = listed
        .iter()
        .find(|skill| skill.name == "plugin-skill")
        .expect("plugin skill should be listed");
    assert_eq!(summary.scope, "global");
    assert_eq!(summary.path, path.to_string_lossy().to_string());
    assert!(!listed_names(&listed).contains(&"nested-skill"));
}

#[test]
fn disabled_plugin_stays_hidden_when_settings_have_other_keys() {
    let scratch = Scratch::new("plugin-off");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let install = scratch.path().join("install");
    write_skill(&install.join("skills"), "disabled-plugin", "hidden");
    write_skill(&claude.join("skills"), "claude-user", "visible");
    write_installed(
        &claude,
        serde_json::json!({
            "disabled-plugin@market": [install_record(&install, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );
    write_enabled(
        &claude.join("settings.json"),
        serde_json::json!({ "disabled-plugin@market": false }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    assert!(listed.iter().any(|skill| skill.name == "claude-user"));
    assert!(!listed.iter().any(|skill| skill.name == "disabled-plugin"));
}

#[test]
fn project_and_local_settings_override_user_plugin_enablement() {
    let scratch = Scratch::new("plugin-scope");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let project = scratch.path().join("project");
    let hidden_install = scratch.path().join("hidden");
    let shown_install = scratch.path().join("shown");
    let local_install = scratch.path().join("local");
    write_skill(&hidden_install.join("skills"), "hidden-plugin", "no");
    write_skill(&shown_install.join("skills"), "shown-plugin", "yes");
    write_skill(&local_install.join("skills"), "local-plugin", "yes");
    write_skill(&claude.join("skills"), "claude-user", "visible");
    write_installed(
        &claude,
        serde_json::json!({
            "hidden-plugin@market": [install_record(&hidden_install, Some("2026-10-15T18:14:07.838Z"))],
            "shown-plugin@market": [install_record(&shown_install, Some("2026-10-15T18:14:07.838Z"))],
            "local-plugin@market": [install_record(&local_install, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );
    write_enabled(
        &claude.join("settings.json"),
        serde_json::json!({
            "hidden-plugin@market": true,
            "shown-plugin@market": false,
            "local-plugin@market": false
        }),
    );
    write_enabled(
        &project.join(".claude").join("settings.json"),
        serde_json::json!({
            "hidden-plugin@market": false,
            "shown-plugin@market": true
        }),
    );
    write_enabled(
        &project.join(".claude").join("settings.local.json"),
        serde_json::json!({ "local-plugin@market": true }),
    );

    let listed =
        list_agent_skills_with_roots(&agents, Some(&claude), Some(&project.to_string_lossy()))
            .unwrap();
    let names = listed_names(&listed);
    assert!(names.contains(&"claude-user"));
    assert!(!names.contains(&"hidden-plugin"));
    assert!(names.contains(&"shown-plugin"));
    assert!(names.contains(&"local-plugin"));
}

#[test]
fn plugin_without_settings_entry_follows_default_enabled() {
    let scratch = Scratch::new("default-enabled");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let off = scratch.path().join("off");
    let on = scratch.path().join("on");
    write_skill(&off.join("skills"), "opt-in-plugin", "hidden");
    write_skill(&on.join("skills"), "default-plugin", "visible");
    write_skill(&claude.join("skills"), "claude-user", "visible");
    write_manifest(&off, Some(false));
    write_installed(
        &claude,
        serde_json::json!({
            "opt-in-plugin@market": [install_record(&off, Some("2026-10-15T18:14:07.838Z"))],
            "default-plugin@market": [install_record(&on, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let names = listed_names(&listed);
    assert!(names.contains(&"claude-user"));
    assert!(names.contains(&"default-plugin"));
    assert!(!names.contains(&"opt-in-plugin"));
}

#[test]
fn newer_plugin_install_record_wins() {
    let scratch = Scratch::new("newer-record");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let old = scratch.path().join("old");
    let new = scratch.path().join("new");
    write_skill(&old.join("skills"), "old-plugin-skill", "old");
    write_skill(&new.join("skills"), "new-plugin-skill", "new");
    write_installed(
        &claude,
        serde_json::json!({
            "demo@market": [
                install_record(&old, Some("2026-01-01T00:00:00Z")),
                install_record(&new, Some("2026-10-15T18:14:07.838Z"))
            ]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let names = listed_names(&listed);
    assert!(names.contains(&"new-plugin-skill"));
    assert!(!names.contains(&"old-plugin-skill"));
}

#[test]
fn equal_plugin_timestamps_use_the_last_eligible_record() {
    let scratch = Scratch::new("tie-record");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let first = scratch.path().join("first");
    let last = scratch.path().join("last");
    write_skill(&first.join("skills"), "first-plugin-skill", "first");
    write_skill(&last.join("skills"), "last-plugin-skill", "last");
    let stamp = "2026-10-15T18:14:07.838Z";
    write_installed(
        &claude,
        serde_json::json!({
            "demo@market": [
                install_record(&first, Some(stamp)),
                install_record(&last, Some(stamp))
            ]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let names = listed_names(&listed);
    assert!(names.contains(&"last-plugin-skill"));
    assert!(!names.contains(&"first-plugin-skill"));
}

#[test]
fn ineligible_plugin_records_are_skipped_without_dropping_the_id() {
    let scratch = Scratch::new("bad-record");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let kept = scratch.path().join("kept");
    let bad_dir = scratch.path().join("bad-stamp");
    write_skill(&kept.join("skills"), "kept-plugin-skill", "kept");
    write_skill(&bad_dir.join("skills"), "bad-stamp-skill", "nope");
    write_skill(&claude.join("skills"), "claude-user", "visible");
    let relative = serde_json::json!({
        "scope": "user",
        "installPath": "relative/plugin",
        "lastUpdated": "2026-12-01T00:00:00Z"
    });
    let missing_dir = install_record(
        &scratch.path().join("missing-plugin-dir"),
        Some("2026-11-01T00:00:00Z"),
    );
    let bad_stamp = install_record(&bad_dir, Some("yesterday"));
    let missing_stamp = install_record(&scratch.path().join("no-stamp"), None);
    write_installed(
        &claude,
        serde_json::json!({
            "demo@market": [
                install_record(&kept, Some("2026-01-01T00:00:00Z")),
                relative,
                missing_dir,
                bad_stamp,
                missing_stamp
            ]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let names = listed_names(&listed);
    assert!(names.contains(&"claude-user"));
    assert!(names.contains(&"kept-plugin-skill"));
    assert!(!names.contains(&"bad-stamp-skill"));
}

#[test]
fn missing_or_malformed_plugin_index_keeps_other_skills() {
    let scratch = Scratch::new("bad-index");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    write_skill(&agents, "agents-skill", "agents");
    write_skill(&claude.join("skills"), "claude-user", "claude");

    let missing = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    assert!(missing.iter().any(|skill| skill.name == "agents-skill"));
    assert!(missing.iter().any(|skill| skill.name == "claude-user"));

    let index = claude.join("plugins").join("installed_plugins.json");
    fs::create_dir_all(index.parent().unwrap()).unwrap();
    fs::write(&index, "{").unwrap();
    let malformed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    assert!(malformed.iter().any(|skill| skill.name == "agents-skill"));
    assert!(malformed.iter().any(|skill| skill.name == "claude-user"));
}

#[test]
fn missing_plugin_directory_is_skipped() {
    let scratch = Scratch::new("missing-dir");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    write_skill(&claude.join("skills"), "claude-user", "visible");
    write_installed(
        &claude,
        serde_json::json!({
            "gone@market": [install_record(&scratch.path().join("not-installed"), Some("2026-10-15T18:14:07.838Z"))]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    assert!(listed.iter().any(|skill| skill.name == "claude-user"));
    assert_eq!(listed.len(), 1);
}

#[test]
fn root_plugin_skill_is_used_only_when_skills_dir_has_no_valid_skill() {
    let scratch = Scratch::new("root-skill");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let root_only = scratch.path().join("root-only");
    let named_by_id = scratch.path().join("named-by-id");
    let invalid_id = scratch.path().join("invalid-id");
    let with_skills = scratch.path().join("with-skills");
    let invalid_children = scratch.path().join("invalid-children");

    let root_path = write_raw_skill(&root_only, &skill_doc("from-frontmatter", "root"));
    write_raw_skill(&named_by_id, "---\ndescription: fallback\n---\n\nbody\n");
    write_raw_skill(&invalid_id, "---\ndescription: bad\n---\n\nbody\n");
    write_skill(&with_skills.join("skills"), "from-skills-dir", "dir");
    write_raw_skill(&with_skills, &skill_doc("from-root-file", "ignored"));
    write_raw_skill(
        &invalid_children.join("skills").join("Invalid"),
        "---\nname: Invalid\n---\n\nno\n",
    );
    write_raw_skill(
        &invalid_children,
        &skill_doc("from-invalid-dir-fallback", "used"),
    );

    write_installed(
        &claude,
        serde_json::json!({
            "root-only@market": [install_record(&root_only, Some("2026-10-15T18:14:07.838Z"))],
            "named-by-id@market": [install_record(&named_by_id, Some("2026-10-15T18:14:07.838Z"))],
            "Not_Valid@market": [install_record(&invalid_id, Some("2026-10-15T18:14:07.838Z"))],
            "packed@market": [install_record(&with_skills, Some("2026-10-15T18:14:07.838Z"))],
            "fallback@market": [install_record(&invalid_children, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let root = listed
        .iter()
        .find(|skill| skill.name == "from-frontmatter")
        .expect("root skill name comes from frontmatter");
    assert_eq!(root.path, root_path.to_string_lossy().to_string());
    assert!(listed.iter().any(|skill| skill.name == "named-by-id"));
    assert!(!listed.iter().any(|skill| skill.name == "Not_Valid"));
    assert!(listed.iter().any(|skill| skill.name == "from-skills-dir"));
    assert!(!listed.iter().any(|skill| skill.name == "from-root-file"));
    assert!(listed
        .iter()
        .any(|skill| skill.name == "from-invalid-dir-fallback"));
}

#[test]
fn duplicate_names_keep_agents_then_project_precedence() {
    let scratch = Scratch::new("precedence");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let project = scratch.path().join("project");
    let install = scratch.path().join("install");
    write_skill(&install.join("skills"), "shared-skill", "plugin");
    write_skill(&claude.join("skills"), "shared-skill", "claude");
    write_skill(&claude.join("skills"), "claude-only", "claude");
    let agents_path = write_skill(&agents, "shared-skill", "agents");
    let project_path = write_skill(
        &project.join(".agents").join("skills"),
        "project-skill",
        "project",
    );
    write_skill(
        &project.join(".agents").join("skills"),
        "shared-skill",
        "project",
    );
    write_installed(
        &claude,
        serde_json::json!({
            "demo@market": [install_record(&install, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );

    let global = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let shared = global
        .iter()
        .find(|skill| skill.name == "shared-skill")
        .expect("shared skill");
    assert_eq!(shared.path, agents_path.to_string_lossy().to_string());
    assert_eq!(shared.scope, "global");
    assert!(global.iter().any(|skill| skill.name == "claude-only"));

    let project_root = project.to_string_lossy().to_string();
    let with_project =
        list_agent_skills_with_roots(&agents, Some(&claude), Some(&project_root)).unwrap();
    let overridden = with_project
        .iter()
        .find(|skill| skill.name == "shared-skill")
        .expect("project override");
    assert_eq!(
        overridden.path,
        project
            .join(".agents")
            .join("skills")
            .join("shared-skill")
            .join("SKILL.md")
            .to_string_lossy()
            .to_string()
    );
    assert_eq!(overridden.scope, "project");
    let project_only = with_project
        .iter()
        .find(|skill| skill.name == "project-skill")
        .expect("project skill");
    assert_eq!(
        project_only.path,
        project_path.to_string_lossy().to_string()
    );

    let content =
        read_agent_skill_with_roots("shared-skill", &agents, Some(&claude), Some(&project_root))
            .unwrap();
    assert_eq!(content.body.trim(), "project");
    assert_eq!(content.scope, "project");
    assert_eq!(content.path, overridden.path);
}

#[test]
fn claude_skills_directory_overrides_plugin_skill_of_the_same_name() {
    let scratch = Scratch::new("claude-over-plugin");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let install = scratch.path().join("install");
    write_skill(&install.join("skills"), "shared-skill", "plugin");
    let claude_path = write_skill(&claude.join("skills"), "shared-skill", "claude");
    write_installed(
        &claude,
        serde_json::json!({
            "demo@market": [install_record(&install, Some("2026-10-15T18:14:07.838Z"))]
        }),
    );

    let listed = list_agent_skills_with_roots(&agents, Some(&claude), None).unwrap();
    let shared = listed
        .iter()
        .find(|skill| skill.name == "shared-skill")
        .expect("shared skill");
    assert_eq!(shared.path, claude_path.to_string_lossy().to_string());
}

#[test]
fn read_claude_skill_returns_original_path_and_body() {
    let scratch = Scratch::new("read-claude");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    let path = write_skill(&claude.join("skills"), "claude-user", "read me");

    let content = read_agent_skill_with_roots("claude-user", &agents, Some(&claude), None).unwrap();
    assert_eq!(content.body.trim(), "read me");
    assert_eq!(content.scope, "global");
    assert_eq!(content.path, path.to_string_lossy().to_string());
}

#[test]
fn list_with_home_does_not_read_claude_fixture() {
    let scratch = Scratch::new("hermetic");
    let claude = scratch.path().join("claude");
    let agents = scratch.path().join("agents");
    write_skill(&agents, "agents-only", "agents");
    write_skill(&claude.join("skills"), "claude-only", "claude");

    let listed = list_agent_skills_with_home(&agents, None).unwrap();
    assert!(listed.iter().any(|skill| skill.name == "agents-only"));
    assert!(!listed.iter().any(|skill| skill.name == "claude-only"));
    assert!(listed
        .iter()
        .all(|skill| Path::new(&skill.path).starts_with(&agents)));
}

#[test]
fn relative_project_root_is_still_rejected() {
    let scratch = Scratch::new("relative-root");
    let err =
        list_agent_skills_with_roots(scratch.path(), None, Some("relative/project")).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
    let read_err =
        read_agent_skill_with_roots("demo-skill", scratch.path(), None, Some("relative/project"))
            .unwrap_err();
    assert!(read_err.contains("absolute"), "{read_err}");
}
