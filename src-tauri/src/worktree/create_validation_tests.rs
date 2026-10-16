use super::*;

fn git_in(dir: &Path, args: &[&str]) {
    let mut cmd = quiet_command(&which_git().expect("git"));
    cmd.args(args).current_dir(dir);
    let out = cmd.output().expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn repo_with_one_commit() -> tempfile::TempDir {
    let project = tempfile::tempdir().unwrap();
    let p = project.path();
    git_in(p, &["init", "--quiet"]);
    git_in(p, &["config", "user.email", "t@t.test"]);
    git_in(p, &["config", "user.name", "t"]);
    git_in(p, &["config", "commit.gpgsign", "false"]);
    git_in(p, &["checkout", "-q", "-b", "main"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    git_in(p, &["add", "a.txt"]);
    git_in(p, &["commit", "-q", "-m", "init"]);
    project
}

#[test]
fn create_rejects_a_name_that_leaves_the_worktrees_folder() {
    for name in [
        "../../escape",
        "..",
        ".",
        "",
        "feat/../x",
        "./x",
        "/abs",
        "feat/./login",
        "feat/.",
        r"feat\.\login",
    ] {
        let err =
            WorktreeManager::create("/no/such/project", name, "chat/x", true, None, None, None)
                .expect_err(name);
        assert_eq!(err.error_code(), "INVALID_WORKTREE_NAME", "name {name:?}");
    }
}

#[test]
fn create_nests_a_slashed_name_under_the_worktrees_folder() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_one_commit();
    let p = project.path().to_str().unwrap();
    WorktreeManager::create(p, "feat/login", "feat/login", true, Some("main"), None, None)
        .expect("a branch-shaped name creates a nested worktree");
    assert!(project
        .path()
        .join(".termul/worktrees/feat/login/a.txt")
        .exists());
}

#[test]
fn create_rejects_an_existing_branch_that_looks_like_a_git_option() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_one_commit();
    let p = project.path().to_str().unwrap();
    let err = WorktreeManager::create(p, "detached", "--detach", false, None, None, None)
        .expect_err("`--detach` is not a branch");
    assert_eq!(err.error_code(), "INVALID_BRANCH_NAME");
    assert!(!project.path().join(".termul/worktrees/detached").exists());
}

#[test]
fn create_rejects_a_new_branch_that_looks_like_a_git_option() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_one_commit();
    let p = project.path().to_str().unwrap();
    git_in(project.path(), &["branch", "victim"]);
    let err = WorktreeManager::create(p, "probe", "-D", true, Some("victim"), None, None)
        .expect_err("`-D` is not a branch");
    assert_eq!(err.error_code(), "INVALID_BRANCH_NAME");
    git_in(
        project.path(),
        &["show-ref", "--verify", "--quiet", "refs/heads/victim"],
    );
    assert!(!project.path().join(".termul/worktrees/probe").exists());
}

#[test]
fn a_branch_ref_collision_is_branch_exists() {
    let err = parse_git_stderr(
        "Preparing worktree (new branch 'chat/ab12cd34')\nfatal: a branch named 'chat/ab12cd34' already exists",
    );
    assert_eq!(err.error_code(), "BRANCH_EXISTS");
}

#[test]
fn create_on_an_existing_branch_name_is_branch_exists() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_one_commit();
    let p = project.path().to_str().unwrap();
    git_in(project.path(), &["branch", "chat/taken"]);
    let err = WorktreeManager::create(p, "taken", "chat/taken", true, Some("main"), None, None)
        .expect_err("branch already exists");
    assert_eq!(err.error_code(), "BRANCH_EXISTS");
}
