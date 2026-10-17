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

fn head(dir: &Path) -> String {
    let (stdout, _) = run_git(&["rev-parse", "HEAD"], dir.to_str()).expect("rev-parse");
    stdout.trim().to_string()
}

/// `main` and `topic` both change `a.txt`, so merging `topic` into `main`
/// stops on a conflict. Returns the repo with `main` checked out.
fn repo_with_diverged_topic() -> tempfile::TempDir {
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
    git_in(p, &["checkout", "-q", "-b", "topic"]);
    std::fs::write(p.join("a.txt"), "topic\n").unwrap();
    std::fs::write(p.join("b.txt"), "b\n").unwrap();
    git_in(p, &["add", "a.txt", "b.txt"]);
    git_in(p, &["commit", "-q", "-m", "topic"]);
    git_in(p, &["checkout", "-q", "main"]);
    project
}

fn start_conflicted_merge(repo: &Path) {
    std::fs::write(repo.join("a.txt"), "main\n").unwrap();
    git_in(repo, &["commit", "-q", "-am", "main change"]);
    let mut cmd = quiet_command(&which_git().expect("git"));
    cmd.args(["merge", "topic"]).current_dir(repo);
    let out = cmd.output().expect("run git");
    assert!(!out.status.success(), "the setup merge must conflict");
    assert!(repo.join(".git/MERGE_HEAD").exists());
}

#[test]
fn merge_execute_rejects_a_branch_that_looks_like_a_git_option() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_diverged_topic();
    let p = project.path();
    start_conflicted_merge(p);
    let before = head(p);
    for target in ["--abort", "-m x", "--quit", "-"] {
        let err = WorktreeManager::merge_execute(p.to_str().unwrap(), target)
            .expect_err("an option is not a branch");
        assert_eq!(err.error_code(), "INVALID_BRANCH_NAME", "target {target:?}");
    }
    assert!(
        p.join(".git/MERGE_HEAD").exists(),
        "the in-progress merge must survive"
    );
    assert_eq!(head(p), before);
}

#[test]
fn merge_preview_rejects_a_branch_that_looks_like_a_git_option() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_diverged_topic();
    let p = project.path();
    for target in ["--abort", "-m x", "--quit", ""] {
        let err = WorktreeManager::merge_preview(p.to_str().unwrap(), target)
            .expect_err("an option is not a branch");
        assert_eq!(err.error_code(), "INVALID_BRANCH_NAME", "target {target:?}");
    }
}

#[test]
fn merge_execute_still_merges_a_named_branch() {
    if which_git().is_err() {
        return;
    }
    let project = repo_with_diverged_topic();
    let p = project.path();
    git_in(p, &["branch", "chat/topic", "topic"]);
    WorktreeManager::merge_execute(p.to_str().unwrap(), "chat/topic")
        .expect("merge a normal branch");
    assert!(p.join("b.txt").exists());
}
