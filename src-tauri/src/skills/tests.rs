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
