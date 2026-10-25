use std::fs;

use super::*;

struct Project {
    dir: tempfile::TempDir,
    outside: tempfile::TempDir,
    staging: tempfile::TempDir,
}

fn project() -> Project {
    let p = Project {
        dir: tempfile::tempdir().unwrap(),
        outside: tempfile::tempdir().unwrap(),
        staging: tempfile::tempdir().unwrap(),
    };
    fs::create_dir_all(p.dir.path().join("docs")).unwrap();
    fs::write(p.dir.path().join("docs/report.pdf"), b"%PDF fake report").unwrap();
    fs::write(p.outside.path().join("secret.txt"), b"FAKE-SECRET-NOT-REAL").unwrap();
    p
}

fn refusal(root: &Path, requested: &str) -> Option<UploadRefusal> {
    open_source(root, requested).err()
}

fn symlink(target: &Path, link: &Path) -> bool {
    crate::browser_automation::engine::files::symlink_file(target, link)
}

#[test]
fn a_project_file_is_staged_byte_for_byte_under_the_staging_dir() {
    let p = project();
    let source = open_source(p.dir.path(), "docs/report.pdf").expect("project file opens");
    let staged = stage(source, p.staging.path()).expect("stages");
    assert!(staged.starts_with(p.staging.path()));
    assert_eq!(staged.file_name().unwrap(), "report.pdf");
    assert_eq!(fs::read(&staged).unwrap(), b"%PDF fake report");
    assert_eq!(
        fs::read(p.dir.path().join("docs/report.pdf")).unwrap(),
        b"%PDF fake report"
    );
}

#[test]
fn secret_shaped_files_are_refused_wherever_they_sit() {
    let p = project();
    let root = p.dir.path();
    for name in [
        ".env",
        ".env.local",
        "server.PEM",
        "deploy.key",
        "id_rsa",
        "id_ed25519.pub",
        "credentials.json",
        ".npmrc",
        "store.p12",
        "login.keychain-db",
        ".git/config",
        "home/.ssh/config",
        "home/.aws/config",
    ] {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"FAKE").unwrap();
        assert_eq!(
            refusal(root, name),
            Some(UploadRefusal::SecretFile),
            "{name}"
        );
    }
    fs::write(root.join("environment.md"), b"notes").unwrap();
    assert!(
        open_source(root, "environment.md").is_ok(),
        "only .env-prefixed names"
    );
}

#[test]
fn files_outside_the_root_missing_files_and_folders_are_refused() {
    let p = project();
    let root = p.dir.path();
    let escape = format!(
        "../{}/secret.txt",
        p.outside.path().file_name().unwrap().to_string_lossy()
    );
    assert_eq!(
        p.outside.path().parent(),
        root.parent(),
        "temp dirs are siblings"
    );
    assert_eq!(refusal(root, &escape), Some(UploadRefusal::OutsideRoot));
    let absolute = p.dir.path().parent().unwrap().join("nope-not-here.txt");
    assert_eq!(
        refusal(root, &absolute.to_string_lossy()),
        Some(UploadRefusal::Missing)
    );
    assert_eq!(
        refusal(root, "docs/missing.pdf"),
        Some(UploadRefusal::Missing)
    );
    assert_eq!(refusal(root, "docs"), Some(UploadRefusal::NotAFile));
    assert_eq!(
        refusal(root, "docs/report.pdf:Zone.Identifier"),
        Some(UploadRefusal::NotAFile)
    );
}

#[test]
fn a_symlink_is_judged_by_the_file_it_opens() {
    let p = project();
    let root = p.dir.path();
    if !symlink(
        &p.outside.path().join("secret.txt"),
        &root.join("innocent.txt"),
    ) {
        eprintln!("skipped: this account cannot create symlinks");
        return;
    }
    assert_eq!(
        refusal(root, "innocent.txt"),
        Some(UploadRefusal::OutsideRoot)
    );

    fs::write(root.join(".env"), b"FAKE=1").unwrap();
    assert!(symlink(&root.join(".env"), &root.join("readme.txt")));
    assert_eq!(refusal(root, "readme.txt"), Some(UploadRefusal::SecretFile));

    assert!(symlink(
        &root.join("docs/report.pdf"),
        &root.join("alias.pdf")
    ));
    let staged = stage(open_source(root, "alias.pdf").unwrap(), p.staging.path()).unwrap();
    assert_eq!(fs::read(staged).unwrap(), b"%PDF fake report");
}

#[test]
fn swapping_the_path_for_a_symlink_after_the_check_stages_the_checked_file() {
    let p = project();
    let root = p.dir.path();
    let checked = open_source(root, "docs/report.pdf").expect("checked");
    fs::rename(root.join("docs/report.pdf"), root.join("docs/moved.pdf")).unwrap();
    if !symlink(
        &p.outside.path().join("secret.txt"),
        &root.join("docs/report.pdf"),
    ) {
        eprintln!("skipped: this account cannot create symlinks");
        return;
    }
    let staged = stage(checked, p.staging.path()).unwrap();
    assert_eq!(fs::read(staged).unwrap(), b"%PDF fake report");
    assert_eq!(
        refusal(root, "docs/report.pdf"),
        Some(UploadRefusal::OutsideRoot),
        "a new upload of the swapped path is refused"
    );
}

#[test]
fn a_file_over_the_limit_is_refused() {
    let p = project();
    let big = File::create(p.dir.path().join("big.bin")).unwrap();
    big.set_len(MAX_UPLOAD_BYTES + 1).unwrap();
    drop(big);
    assert_eq!(
        refusal(p.dir.path(), "big.bin"),
        Some(UploadRefusal::TooLarge)
    );
}

#[test]
fn files_the_project_git_ignores_are_refused() {
    let p = project();
    let root = p.dir.path();
    let init = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["init", "-q"])
        .status();
    if !init.is_ok_and(|s| s.success()) {
        eprintln!("skipped: git is not available");
        return;
    }
    fs::write(root.join(".gitignore"), "build/\n").unwrap();
    fs::create_dir_all(root.join("build")).unwrap();
    fs::write(root.join("build/app.zip"), b"zip").unwrap();
    assert_eq!(
        refusal(root, "build/app.zip"),
        Some(UploadRefusal::IgnoredFile)
    );
    assert!(open_source(root, "docs/report.pdf").is_ok());
}

#[test]
fn staged_names_keep_the_base_name_and_drop_path_tricks() {
    assert_eq!(
        staged_name(Path::new("/p/report final.pdf")),
        "report final.pdf"
    );
    assert_eq!(staged_name(Path::new("/p/a<b>|c.txt")), "a_b__c.txt");
    assert_eq!(staged_name(Path::new("/p/...")), "upload");
}

#[test]
fn a_hard_link_to_a_file_outside_the_root_is_refused() {
    let p = project();
    let linked = p.dir.path().join("docs/linked.txt");
    fs::hard_link(p.outside.path().join("secret.txt"), &linked).unwrap();
    assert_eq!(refusal(p.dir.path(), "docs/linked.txt"), Some(UploadRefusal::HardLinked));
}

#[test]
fn a_drive_root_is_never_an_upload_root() {
    let p = project();
    let drive = p.dir.path().ancestors().last().unwrap().to_path_buf();
    assert_eq!(refusal(&drive, "anything.txt"), Some(UploadRefusal::BroadRoot));
}

#[test]
fn the_ticket_names_the_opened_file_by_base_name_and_size() {
    let p = project();
    let source = open_source(p.dir.path(), "docs/report.pdf").unwrap();
    assert_eq!(
        source.ticket_file(),
        TicketFile {
            name: "report.pdf".into(),
            bytes: 16,
        }
    );
}
