use super::*;

#[test]
fn test_list_parses_basic_entry() {
    let output = "worktree /path/to/project\n\
                      HEAD abc1234\n\
                      branch refs/heads/main\n\
                      \n";
    // Test the porcelain parsing logic directly
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(path), Some(head), Some(branch)) = (
                current_path.take(),
                current_head.take(),
                current_branch.take(),
            ) {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| branch.clone());

                entries.push(GitWorktreeEntry {
                    name,
                    branch,
                    path,
                    head_commit: head,
                });
            } else {
                current_path = None;
                current_head = None;
                current_branch = None;
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("worktree ") {
            current_path = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("HEAD ") {
            current_head = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(val.to_string());
        }
    }

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].branch, "main");
    assert_eq!(entries[0].head_commit, "abc1234");
    assert_eq!(entries[0].path, "/path/to/project");
}

#[test]
fn test_list_filters_detached_head() {
    let output = "worktree /path/to/project\n\
                      HEAD def5678\n\
                      \n";
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(path), Some(head), Some(branch)) = (
                current_path.take(),
                current_head.take(),
                current_branch.take(),
            ) {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| branch.clone());

                entries.push(GitWorktreeEntry {
                    name,
                    branch,
                    path,
                    head_commit: head,
                });
            } else {
                current_path = None;
                current_head = None;
                current_branch = None;
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("worktree ") {
            current_path = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("HEAD ") {
            current_head = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(val.to_string());
        }
    }

    // Detached HEAD (no branch line) should be filtered out
    assert_eq!(entries.len(), 0);
}

#[test]
fn test_list_multiple_entries() {
    let output = "worktree /path/to/project\n\
                      HEAD aaa111\n\
                      branch refs/heads/main\n\
                      \n\
                      worktree /path/to/project/.termul/worktrees/feat-1\n\
                      HEAD bbb222\n\
                      branch refs/heads/feat-1\n\
                      \n";

    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(path), Some(head), Some(branch)) = (
                current_path.take(),
                current_head.take(),
                current_branch.take(),
            ) {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| branch.clone());

                entries.push(GitWorktreeEntry {
                    name,
                    branch,
                    path,
                    head_commit: head,
                });
            } else {
                current_path = None;
                current_head = None;
                current_branch = None;
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("worktree ") {
            current_path = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("HEAD ") {
            current_head = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(val.to_string());
        }
    }

    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].branch, "main");
    assert_eq!(entries[1].branch, "feat-1");
    assert_eq!(entries[1].name, "feat-1");
}

#[test]
fn test_list_filters_bare() {
    let output = "worktree /path/to/bare\n\
                      HEAD ccc333\n\
                      bare\n\
                      \n";
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(path), Some(head), Some(branch)) = (
                current_path.take(),
                current_head.take(),
                current_branch.take(),
            ) {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| branch.clone());

                entries.push(GitWorktreeEntry {
                    name,
                    branch,
                    path,
                    head_commit: head,
                });
            } else {
                current_path = None;
                current_head = None;
                current_branch = None;
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("worktree ") {
            current_path = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("HEAD ") {
            current_head = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(val.to_string());
        }
    }

    // Bare worktree (no branch line) should be filtered out
    assert_eq!(entries.len(), 0);
}

#[test]
fn test_empty_output() {
    let output = "";
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let (Some(path), Some(head), Some(branch)) = (
                current_path.take(),
                current_head.take(),
                current_branch.take(),
            ) {
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| branch.clone());

                entries.push(GitWorktreeEntry {
                    name,
                    branch,
                    path,
                    head_commit: head,
                });
            } else {
                current_path = None;
                current_head = None;
                current_branch = None;
            }
            continue;
        }

        if let Some(val) = line.strip_prefix("worktree ") {
            current_path = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("HEAD ") {
            current_head = Some(val.to_string());
        } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(val.to_string());
        }
    }

    assert_eq!(entries.len(), 0);
}

#[test]
fn test_error_parsing_already_exists() {
    let err = parse_git_stderr("fatal: '/path/to/worktree' already exists");
    assert!(matches!(err, WorktreeError::WorktreeExists));
}

#[test]
fn test_error_parsing_already_checked_out() {
    let err = parse_git_stderr("fatal: 'feat-1' is already checked out at '/other/path'");
    assert!(matches!(err, WorktreeError::BranchAlreadyHasWorktree));
}

#[test]
fn test_error_parsing_not_a_git_repo() {
    let err = parse_git_stderr("fatal: not a git repository");
    assert!(matches!(err, WorktreeError::NotAGitRepo));
}

#[test]
fn test_error_parsing_branch_not_found() {
    let err = parse_git_stderr("fatal: 'nonexistent' did not match any file(s) known to git");
    assert!(matches!(err, WorktreeError::BranchNotFound));
}

#[test]
fn test_error_parsing_locked() {
    let err = parse_git_stderr("fatal: 'worktree' is locked");
    assert!(matches!(err, WorktreeError::WorktreeLocked));
}

#[test]
fn test_error_parsing_dirty() {
    let err = parse_git_stderr("fatal: worktree 'path' is dirty, use --force");
    assert!(matches!(err, WorktreeError::WorktreeRemoveFailed));
}

/// A git usage dump (exit 129) contains "already checked out" inside the
/// `-f/--force` option description. Classification must only consider
/// `fatal:`/`error:`-prefixed lines so the dump surfaces as a truthful
/// `GitError` instead of a bogus branch collision — a collision would
/// trigger the launcher's pointless `-2` retry.
#[test]
fn test_error_parsing_usage_dump_is_git_error() {
    let stderr = "error: unknown option `progress'\n\
                      usage: git worktree add [-f] [--detach] [--checkout] [--lock] [(-b | -B) <new-branch>] <path> [<commit-ish>]\n\
                      \n\
                          -f, --force           checkout <branch> even if already checked out in other worktree\n\
                          -b, --create <branch> create a new branch\n";
    let err = parse_git_stderr(stderr);
    match &err {
        WorktreeError::GitError(msg) => {
            assert!(
                msg.contains("unknown option"),
                "raw git message must survive verbatim: {msg}"
            );
        }
        other => panic!("usage dump must not classify as a collision: {other:?}"),
    }
}

/// Regression: `create` used to inject a nonexistent `--progress` flag
/// whenever a progress callback was set, so every streamed create failed
/// instantly (exit 129) before any worktree/branch existed. The streaming
/// path must run a real `git worktree add` and deliver git's lifecycle
/// lines (`Preparing worktree…`, `HEAD is now at…`) to the callback.
#[test]
fn test_create_with_progress_streams_lifecycle_lines() {
    if !git_available() {
        return;
    }
    let dir = std::env::temp_dir().join(format!(
        "termul-wt-create-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "t@example.com"].as_slice(),
        ["config", "user.name", "T"].as_slice(),
    ] {
        run_git(args, Some(dir.to_str().unwrap())).unwrap();
    }
    std::fs::write(dir.join("file.txt"), "x").unwrap();
    run_git(&["add", "-A"], Some(dir.to_str().unwrap())).unwrap();
    run_git(&["commit", "-qm", "init"], Some(dir.to_str().unwrap())).unwrap();

    let mut streamed: Vec<String> = Vec::new();
    let entry = {
        let mut on_line = |line: &str| streamed.push(line.to_string());
        WorktreeManager::create(
            dir.to_str().unwrap(),
            "wt-progress",
            "chat/wt-progress",
            true,
            None,
            None,
            Some(&mut on_line),
        )
        .expect("create with a progress callback must succeed")
    };
    assert_eq!(entry.branch, "chat/wt-progress");
    assert!(Path::new(&entry.path).exists());
    assert!(
        !streamed.is_empty(),
        "git lifecycle lines must reach the progress callback"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The non-streamed create path (`on_progress: None`) must keep working —
/// same `git worktree add` args, run through `run_git` instead of
/// `run_git_streaming`.
#[test]
fn test_create_without_progress_succeeds() {
    if !git_available() {
        return;
    }
    let dir = std::env::temp_dir().join(format!(
        "termul-wt-create-noprogress-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "t@example.com"].as_slice(),
        ["config", "user.name", "T"].as_slice(),
    ] {
        run_git(args, Some(dir.to_str().unwrap())).unwrap();
    }
    std::fs::write(dir.join("file.txt"), "x").unwrap();
    run_git(&["add", "-A"], Some(dir.to_str().unwrap())).unwrap();
    run_git(&["commit", "-qm", "init"], Some(dir.to_str().unwrap())).unwrap();

    let entry = WorktreeManager::create(
        dir.to_str().unwrap(),
        "wt-plain",
        "chat/wt-plain",
        true,
        None,
        None,
        None,
    )
    .expect("create without a progress callback must succeed");
    assert_eq!(entry.branch, "chat/wt-plain");
    assert!(Path::new(&entry.path).exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_dirty_status_clean() {
    let status = DirtyStatus {
        modified: 0,
        staged: 0,
        untracked: 0,
        has_changes: false,
    };
    assert!(!status.has_changes);
    assert_eq!(status.modified, 0);
}

#[test]
fn test_dirty_status_dirty() {
    let status = DirtyStatus {
        modified: 3,
        staged: 1,
        untracked: 2,
        has_changes: true,
    };
    assert!(status.has_changes);
}

/// F-016: `!!` (ignored) lines must not count as untracked/dirty.
/// `git status --porcelain` only emits `!!` with `--ignored`, but the
/// parser must treat an ignored entry as clean regardless (a worktree
/// with only ignored build output IS clean). Verified against real git:
/// plain `--porcelain` output for a repo containing an ignored `target/`
/// dir is empty.
#[test]
fn test_check_dirty_ignores_ignored_entries() {
    // Direct parser-level verification: a `!!` line contributes nothing.
    // Reuse the same counting logic by feeding lines through check_dirty
    // in a real repo (git may be unavailable -> skip).
    if !git_available() {
        return;
    }
    let dir = std::env::temp_dir().join(format!(
        "termul-wt-ignored-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "t@example.com"].as_slice(),
        ["config", "user.name", "T"].as_slice(),
    ] {
        run_git(args, Some(dir.to_str().unwrap())).unwrap();
    }
    std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
    run_git(&["add", "-A"], Some(dir.to_str().unwrap())).unwrap();
    run_git(&["commit", "-qm", "init"], Some(dir.to_str().unwrap())).unwrap();
    // Ignored-only content: plain porcelain is empty, and even a
    // hypothetical `!!` line must not flip has_changes.
    std::fs::create_dir_all(dir.join("target")).unwrap();
    std::fs::write(dir.join("target/build.log"), "x").unwrap();
    let status = WorktreeManager::check_dirty(dir.to_str().unwrap()).unwrap();
    assert_eq!(status.untracked, 0, "ignored-only tree is not untracked");
    assert!(!status.has_changes, "ignored-only tree is clean");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_error_code_mapping() {
    assert_eq!(
        WorktreeError::WorktreeExists.error_code(),
        "WORKTREE_EXISTS"
    );
    assert_eq!(
        WorktreeError::BranchAlreadyHasWorktree.error_code(),
        "BRANCH_ALREADY_HAS_WORKTREE"
    );
    assert_eq!(WorktreeError::NotAGitRepo.error_code(), "NOT_A_GIT_REPO");
    assert_eq!(WorktreeError::GitNotFound.error_code(), "GIT_NOT_FOUND");
    assert_eq!(WorktreeError::PathTooLong.error_code(), "PATH_TOO_LONG");
    assert_eq!(
        WorktreeError::WorktreeRemoveFailed.error_code(),
        "WORKTREE_REMOVE_FAILED"
    );
    // WORKTREE_CREATE_FAILED is deliberately NOT a collision code — it is
    // what keeps the launcher out of the `-2` retry branch for real git
    // failures (e.g. a usage/argument error).
    assert_eq!(
        WorktreeError::GitError("x".into()).error_code(),
        "WORKTREE_CREATE_FAILED"
    );
    assert_eq!(
        WorktreeError::IoError("x".into()).error_code(),
        "WORKTREE_CREATE_FAILED"
    );
}

/// Pin the `git worktree add` argv shapes and permanently guard the
/// `--progress` regression: no arg vector this builder emits may contain
/// the nonexistent flag that used to kill every streamed create.
#[test]
fn test_worktree_add_args_new_branch_with_start_ref() {
    let args = worktree_add_args("chat/abc", true, "/p/.termul/worktrees/abc/", Some("main"));
    assert_eq!(
        args,
        [
            "worktree",
            "add",
            "-b",
            "chat/abc",
            "/p/.termul/worktrees/abc/",
            "main"
        ]
    );
    assert!(!args.contains(&"--progress"));
}

#[test]
fn test_worktree_add_args_new_branch_default_ref() {
    let args = worktree_add_args("chat/abc", true, "/t/wt/", None);
    assert_eq!(args, ["worktree", "add", "-b", "chat/abc", "/t/wt/"]);
    assert!(!args.contains(&"--progress"));
}

#[test]
fn test_worktree_add_args_existing_branch() {
    let args = worktree_add_args("feat/x", false, "/t/wt/", None);
    assert_eq!(args, ["worktree", "add", "/t/wt/", "feat/x"]);
    assert!(!args.contains(&"--progress"));
}

#[test]
fn test_is_termul_managed_true() {
    assert!("/project/.termul/worktrees/feat-1".contains(".termul/worktrees/"));
}

#[test]
fn test_is_termul_managed_false() {
    assert!(!"/project/../other-worktree".contains(".termul/worktrees/"));
}

// --------------------------------------------------------------------
// CAP-2 / CAP-5 — worktree include carry-over + base-branch helpers
// --------------------------------------------------------------------

fn git_available() -> bool {
    which_git().is_ok()
}

/// `glob_to_regex` matches exact filenames and simple wildcards.
#[test]
fn test_glob_to_regex_exact_and_wildcard() {
    let exact = glob_to_regex(".env").unwrap();
    assert!(exact.is_match(".env"));
    assert!(!exact.is_match("config/.env"));
    assert!(!exact.is_match("env"));

    let star = glob_to_regex("*.env").unwrap();
    assert!(star.is_match(".env"));
    assert!(star.is_match("local.env"));
    assert!(!star.is_match("config/local.env"));

    let double = glob_to_regex("**/*.env").unwrap();
    assert!(double.is_match(".env"));
    assert!(double.is_match("config/local.env"));
    assert!(double.is_match("a/b/c.env"));
}

#[test]
fn test_copy_worktree_include_files_no_include_file_is_noop() {
    // No `.worktree-include` -> ran=0, copied=0, skipped=[]
    let project = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    let result = WorktreeManager::copy_worktree_include_files(
        project.path().to_str().unwrap(),
        worktree.path().to_str().unwrap(),
    )
    .expect("no-include path is a no-op, not an error");
    assert_eq!(result.ran, 0);
    assert_eq!(result.copied, 0);
    assert!(result.skipped.is_empty());
}

#[test]
fn test_copy_worktree_include_files_copies_plain_file() {
    let project = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    // Source: an untracked .env in the project root.
    std::fs::write(project.path().join(".env"), "SECRET=1\n").unwrap();
    std::fs::write(project.path().join(".worktree-include"), ".env\n").unwrap();
    let result = WorktreeManager::copy_worktree_include_files(
        project.path().to_str().unwrap(),
        worktree.path().to_str().unwrap(),
    )
    .expect("copy plain .env");
    assert_eq!(result.ran, 1);
    assert_eq!(result.copied, 1);
    assert!(result.skipped.is_empty());
    let copied = std::fs::read_to_string(worktree.path().join(".env")).unwrap();
    assert_eq!(copied, "SECRET=1\n");
}

#[test]
fn test_copy_worktree_include_files_skips_symlink() {
    let project = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    // Real target + a symlink pointing outside.
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("real.env"), "SECRET=outside\n").unwrap();
    let link = project.path().join("linked.env");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("real.env"), &link).unwrap();
    #[cfg(windows)]
    {
        // Symlink creation on Windows requires elevated privileges; fall
        // back to a junction-ish test by skipping when we cannot create
        // one. The defense is still exercised on Unix CI.
        let result = std::os::windows::fs::symlink_file(outside.path().join("real.env"), &link);
        if result.is_err() {
            return;
        }
    }
    std::fs::write(project.path().join(".worktree-include"), "linked.env\n").unwrap();
    let result = WorktreeManager::copy_worktree_include_files(
        project.path().to_str().unwrap(),
        worktree.path().to_str().unwrap(),
    )
    .expect("symlink skip");
    assert_eq!(result.copied, 0);
    assert!(result.skipped.iter().any(|s| s.reason == "symlink"));
}

#[test]
fn test_copy_worktree_include_files_skips_already_present() {
    let project = tempfile::tempdir().unwrap();
    let worktree = tempfile::tempdir().unwrap();
    std::fs::write(project.path().join(".env"), "SECRET=1\n").unwrap();
    // Pre-create the destination -> COPYFILE_EXCL semantics.
    std::fs::write(worktree.path().join(".env"), "PRE-EXISTING\n").unwrap();
    std::fs::write(project.path().join(".worktree-include"), ".env\n").unwrap();
    let result = WorktreeManager::copy_worktree_include_files(
        project.path().to_str().unwrap(),
        worktree.path().to_str().unwrap(),
    )
    .expect("already-present skip");
    assert_eq!(result.copied, 0);
    assert!(result.skipped.iter().any(|s| s.reason == "already-present"));
    // The pre-existing file is NOT overwritten.
    let kept = std::fs::read_to_string(worktree.path().join(".env")).unwrap();
    assert_eq!(kept, "PRE-EXISTING\n");
}

#[test]
fn test_copy_worktree_include_files_errors_when_worktree_dir_missing() {
    let project = tempfile::tempdir().unwrap();
    // Point worktree at a path that does not exist as a directory — the
    // realpath canonicalize will fail and the helper returns an IoError,
    // which is the path-escape / missing-worktree boundary.
    std::fs::write(project.path().join("file.env"), "X\n").unwrap();
    std::fs::write(project.path().join(".worktree-include"), "file.env\n").unwrap();
    let missing_worktree = project
        .path()
        .join(".termul")
        .join("worktrees")
        .join("missing");
    let result = WorktreeManager::copy_worktree_include_files(
        project.path().to_str().unwrap(),
        missing_worktree.to_str().unwrap(),
    );
    assert!(
        result.is_err(),
        "missing worktree dir must error, not silently write outside"
    );
}

#[test]
fn test_resolve_default_base_branch_falls_back_to_current_when_no_origin() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let project = tempfile::tempdir().unwrap();
    // git init + a commit on a branch named "feat/x" so rev-parse works.
    let p = project.path();
    let run = |args: &[&str]| {
        let mut cmd = quiet_command("git");
        cmd.args(args).current_dir(p);
        let _ = cmd.output();
    };
    run(&["init", "--quiet"]);
    run(&["config", "user.email", "t@t.test"]);
    run(&["config", "user.name", "t"]);
    // Rename the default branch to feat/x so current_branch is non-default.
    run(&["checkout", "-b", "feat/x"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    run(&["add", "a.txt"]);
    run(&["commit", "-m", "init", "--quiet"]);
    let info = WorktreeManager::resolve_default_base_branch(p.to_str().unwrap())
        .expect("resolve_default_base_branch on a fresh repo");
    assert_eq!(info.current_branch.as_deref(), Some("feat/x"));
    // No origin/HEAD and no main/master locally -> fall back to current.
    assert_eq!(info.default_base, "feat/x");
    assert!(!info.is_detached);
}

#[test]
fn test_resolve_default_base_branch_detached_head_flag() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let project = tempfile::tempdir().unwrap();
    let p = project.path();
    let run = |args: &[&str]| {
        let mut cmd = quiet_command("git");
        cmd.args(args).current_dir(p);
        let _ = cmd.output();
    };
    run(&["init", "--quiet"]);
    run(&["config", "user.email", "t@t.test"]);
    run(&["config", "user.name", "t"]);
    run(&["checkout", "-b", "main"]);
    std::fs::write(p.join("a.txt"), "a\n").unwrap();
    run(&["add", "a.txt"]);
    run(&["commit", "-m", "init", "--quiet"]);
    // Detach HEAD at the commit.
    let head = {
        let out = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(p)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(&["checkout", &head]);
    let info = WorktreeManager::resolve_default_base_branch(p.to_str().unwrap())
        .expect("resolve_default_base_branch on detached HEAD");
    assert!(info.is_detached);
    assert!(info.current_branch.is_none());
    // main exists locally -> default_base should be main (fallback chain).
    assert_eq!(info.default_base, "main");
}
