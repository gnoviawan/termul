use super::*;

fn generations(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_type().unwrap().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn the_global_profile_survives_a_restart_in_the_same_generation() {
    let app_data = tempfile::tempdir().unwrap();
    let root = app_data.path().join(GLOBAL_ROOT);
    let first = AgentProfiles::open(root.clone()).unwrap().global_dir();
    std::fs::write(first.join("Cookies"), b"login").unwrap();

    let again = AgentProfiles::open(root.clone()).unwrap();
    assert_eq!(again.global_dir(), first);
    assert_eq!(std::fs::read(first.join("Cookies")).unwrap(), b"login");
    assert!(again.stale_generations().is_empty());
}

#[test]
fn rotating_starts_an_empty_generation_and_marks_the_old_one_stale() {
    let app_data = tempfile::tempdir().unwrap();
    let root = app_data.path().join(GLOBAL_ROOT);
    let profiles = AgentProfiles::open(root.clone()).unwrap();
    let old_dir = profiles.global_dir();
    std::fs::write(old_dir.join("Cookies"), b"login").unwrap();

    let old = profiles.rotate().unwrap();
    let fresh = profiles.global_dir();
    assert_ne!(fresh, old_dir);
    assert_eq!(
        std::fs::read_dir(&fresh).unwrap().count(),
        0,
        "the new generation is empty"
    );
    assert_eq!(profiles.stale_generations(), [old]);
    assert_eq!(
        AgentProfiles::open(root.clone()).unwrap().global_dir(),
        fresh,
        "a restart opens the new generation"
    );
    assert!(delete_dir(&old_dir));
    assert_eq!(
        generations(&root),
        [fresh.file_name().unwrap().to_string_lossy().into_owned()]
    );
}

#[test]
fn an_unreadable_generation_record_starts_a_fresh_profile() {
    let app_data = tempfile::tempdir().unwrap();
    let root = app_data.path().join(GLOBAL_ROOT);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(CURRENT_FILE), b"../../elsewhere").unwrap();
    let dir = AgentProfiles::open(root.clone()).unwrap().global_dir();
    assert_eq!(dir.parent(), Some(root.as_path()));
    assert!(Generation::parse("../../elsewhere").is_none());
    assert!(
        Generation::parse("0B7C2D1E-5F60-4A1B-9C2D-3E4F5A6B7C8D").is_none(),
        "only the simple form"
    );
}

#[test]
fn the_global_profile_lives_under_app_data_only() {
    let app_data = tempfile::tempdir().unwrap();
    let root = app_data.path().join(GLOBAL_ROOT);
    let global = AgentProfiles::open(root.clone()).unwrap().global_dir();
    assert_eq!(global.parent(), Some(root.as_path()));
    assert!(global.starts_with(app_data.path()));
}

#[test]
fn macos_below_14_reports_the_global_profile_unavailable() {
    assert_eq!(
        macos_support(Some(13)),
        Support::Unavailable("macos_version")
    );
    assert_eq!(macos_support(None), Support::Unavailable("macos_version"));
    assert_eq!(macos_support(Some(14)), Support::Trusted);
    assert_eq!(macos_support(Some(15)), Support::Trusted);
}

#[test]
fn deleting_a_missing_directory_is_done() {
    let root = tempfile::tempdir().unwrap();
    assert!(delete_dir(&root.path().join("never-created")));
}
