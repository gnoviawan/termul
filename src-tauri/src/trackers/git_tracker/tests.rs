use super::*;

#[test]
fn resolve_executable_returns_unresolved_name_unchanged() {
    // A bare name that does not exist on PATH should come back unchanged so
    // the spawn still produces a meaningful "not found" error rather than
    // silently rewriting to something else.
    let unlikely = "termul-nonexistent-agent-xyz";
    assert_eq!(resolve_executable(unlikely), unlikely);
}

#[test]
fn resolve_executable_preserves_explicit_path() {
    // An explicit (non-existent) path is returned unchanged on all
    // platforms; the caller surfaces the spawn error.
    let p = if cfg!(windows) {
        "C:\\nope\\agent.exe"
    } else {
        "/nope/agent"
    };
    assert_eq!(resolve_executable(p), p);
}

#[test]
fn test_build_diff_args_untracked_uses_no_index() {
    // Untracked files have no index entry; staged flag is irrelevant.
    assert_eq!(
        build_diff_args("new.txt", true, false),
        vec!["diff", "--no-index", "--", NULL_DEVICE, "new.txt"]
    );
    assert_eq!(
        build_diff_args("new.txt", true, true),
        vec!["diff", "--no-index", "--", NULL_DEVICE, "new.txt"]
    );
}

#[test]
fn test_build_diff_args_staged_uses_cached() {
    assert_eq!(
        build_diff_args("a.txt", false, true),
        vec!["diff", "--cached", "--", "a.txt"]
    );
}

#[test]
fn test_build_diff_args_unstaged_uses_worktree() {
    // Unstaged tracked diff compares worktree against the index (no HEAD,
    // no --cached), so the staged and unstaged rows of one file differ.
    assert_eq!(
        build_diff_args("a.txt", false, false),
        vec!["diff", "--", "a.txt"]
    );
}

#[test]
fn test_classify_discard_action_untracked() {
    assert_eq!(
        classify_discard_action("?? new.txt"),
        DiscardAction::DeleteUntracked
    );
}

#[test]
fn test_classify_discard_action_added_reverts_worktree() {
    // A staged-added file with no worktree change reverts the worktree only;
    // git checkout -- <path> is a safe no-op that never deletes staged content.
    assert_eq!(
        classify_discard_action("A  added.txt"),
        DiscardAction::RevertWorktree
    );
}

#[test]
fn test_classify_discard_action_modified_variants_revert_worktree() {
    // Worktree-modified, staged-modified, MM, and deleted all revert the
    // working tree to the index without touching staged content.
    assert_eq!(
        classify_discard_action(" M mod.txt"),
        DiscardAction::RevertWorktree
    );
    assert_eq!(
        classify_discard_action("M  staged.txt"),
        DiscardAction::RevertWorktree
    );
    assert_eq!(
        classify_discard_action("MM both.txt"),
        DiscardAction::RevertWorktree
    );
    assert_eq!(
        classify_discard_action(" D del.txt"),
        DiscardAction::RevertWorktree
    );
}

#[test]
fn test_classify_discard_action_empty_is_noop() {
    assert_eq!(classify_discard_action(""), DiscardAction::Noop);
    assert_eq!(classify_discard_action("   "), DiscardAction::Noop);
}

#[test]
fn test_is_safe_relative_path() {
    assert!(is_safe_relative_path("src/main.rs"));
    assert!(is_safe_relative_path("a.txt"));
    assert!(is_safe_relative_path("dir/sub/file"));
    // Traversal and absolute / drive-rooted paths are rejected.
    assert!(!is_safe_relative_path("../escape.txt"));
    assert!(!is_safe_relative_path("a/../../b"));
    assert!(!is_safe_relative_path("/etc/passwd"));
    // A whole-repo pathspec (".", "./", "") must never satisfy the
    // raw-filesystem delete guard: `git_discard_file` on "." would
    // otherwise `remove_dir_all` the entire working tree including
    // `.git` (F-006). The discard contract is a single-file op.
    assert!(!is_safe_relative_path("."));
    assert!(!is_safe_relative_path("./"));
    assert!(!is_safe_relative_path(""));
    assert!(!is_safe_relative_path("dir/.."));
    assert!(!is_safe_relative_path("dir/."));
    #[cfg(target_os = "windows")]
    {
        assert!(!is_safe_relative_path("C:\\Windows\\x"));
        assert!(!is_safe_relative_path("\\\\server\\share"));
        assert!(!is_safe_relative_path(".\\"));
    }
}

#[test]
fn test_parse_git_status_empty() {
    let status = GitTracker::parse_git_status("");
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 0);
    assert_eq!(status.untracked, 0);
    assert!(!status.has_changes);
}

#[test]
fn test_parse_git_status_untracked() {
    let status = GitTracker::parse_git_status("?? new-file.txt\n?? another.txt\n");
    assert_eq!(status.untracked, 2);
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 0);
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_modified() {
    let status = GitTracker::parse_git_status(" M modified.txt\n D deleted.txt\n");
    assert_eq!(status.untracked, 0);
    assert_eq!(status.modified, 2);
    assert_eq!(status.staged, 0);
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_staged() {
    let status =
        GitTracker::parse_git_status("M  staged.txt\nA  added.txt\nD  deleted-staged.txt\n");
    assert_eq!(status.untracked, 0);
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 3);
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_staged_and_modified() {
    let status = GitTracker::parse_git_status("MM both-changed.txt\n");
    assert_eq!(status.untracked, 0);
    assert_eq!(status.modified, 1); // Work tree has M
    assert_eq!(status.staged, 1); // Index has M
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_mixed() {
    let output = "?? untracked.txt\n M modified.txt\nM  staged.txt\nMM both.txt\n";
    let status = GitTracker::parse_git_status(output);
    assert_eq!(status.untracked, 1);
    assert_eq!(status.modified, 2); // modified.txt + both.txt (work tree)
    assert_eq!(status.staged, 2); // staged.txt + both.txt (index)
    assert!(status.has_changes);
}

#[test]
fn test_git_status_new() {
    let status = GitStatus::new();
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 0);
    assert_eq!(status.untracked, 0);
    assert!(!status.has_changes);
}

#[test]
fn test_git_status_default() {
    let status = GitStatus::default();
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 0);
    assert_eq!(status.untracked, 0);
    assert!(!status.has_changes);
}

#[test]
fn test_git_state_update_terminal_cwd_changes_value() {
    let mut state = GitState {
        _terminal_id: "term-1".to_string(),
        last_known_branch: Some("main".to_string()),
        last_known_cwd: "/tmp".to_string(),
        last_known_status: Some(GitStatus::new()),
    };

    assert!(state.update_terminal_cwd("/tmp/repo".to_string()));
    assert_eq!(state.last_known_cwd, "/tmp/repo");
}

#[test]
fn test_git_state_update_terminal_cwd_no_change() {
    let mut state = GitState {
        _terminal_id: "term-1".to_string(),
        last_known_branch: Some("main".to_string()),
        last_known_cwd: "/tmp".to_string(),
        last_known_status: Some(GitStatus::new()),
    };

    assert!(!state.update_terminal_cwd("/tmp".to_string()));
    assert_eq!(state.last_known_cwd, "/tmp");
}

#[test]
fn test_parse_git_status_renamed() {
    // Renamed files show as R
    let status = GitTracker::parse_git_status("R  renamed.txt\n");
    assert_eq!(status.untracked, 0);
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 1); // R in index counts as staged
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_rename_with_similarity() {
    let status = GitTracker::parse_git_status("R100 old.txt -> new.txt\n");
    assert_eq!(status.untracked, 0);
    assert_eq!(status.modified, 0);
    assert_eq!(status.staged, 1);
    assert!(status.has_changes);
}

#[test]
fn test_parse_git_status_ignored_lines() {
    // Short lines should be skipped
    let status = GitTracker::parse_git_status("M\n\n?? file.txt\n");
    assert_eq!(status.untracked, 1);
    assert_eq!(status.modified, 0);
    assert!(status.has_changes);
}

#[test]
fn test_git_get_status_detail_skips_short_lines() {
    let details = git_get_status_detail_from_output("M\n\n?? file.txt\n");
    assert_eq!(details.len(), 1);
    assert_eq!(details[0].path, "file.txt");
    assert_eq!(details[0].status, "untracked");
    assert!(!details[0].staged);
}

#[test]
fn test_git_get_status_detail_parses_staged_and_unstaged_entries() {
    let details = git_get_status_detail_from_output("MM both.txt\nA  added.txt\n D deleted.txt\n");
    assert_eq!(details.len(), 4);

    assert_eq!(details[0].path, "both.txt");
    assert_eq!(details[0].status, "modified");
    assert!(details[0].staged);

    assert_eq!(details[1].path, "both.txt");
    assert_eq!(details[1].status, "modified");
    assert!(!details[1].staged);

    assert_eq!(details[2].path, "added.txt");
    assert_eq!(details[2].status, "added");
    assert!(details[2].staged);

    assert_eq!(details[3].path, "deleted.txt");
    assert_eq!(details[3].status, "deleted");
    assert!(!details[3].staged);
}

#[test]
fn test_git_get_status_detail_uses_rename_destination_path() {
    let details = git_get_status_detail_from_output("RM old.txt -> new.txt\n");
    assert_eq!(details.len(), 2);
    assert_eq!(details[0].path, "new.txt");
    assert_eq!(details[0].status, "renamed");
    assert!(details[0].staged);
    assert_eq!(details[1].path, "new.txt");
    assert_eq!(details[1].status, "modified");
    assert!(!details[1].staged);
}

// ========== parse_git_log unit tests ==========

/// Build one NUL-delimited, record-terminated log record matching the
/// `git_get_log` pretty format: hash, shortHash, parents, refs, author,
/// date, subject.
fn log_record(
    hash: &str,
    short: &str,
    parents: &str,
    refs: &str,
    author: &str,
    date: &str,
    subject: &str,
) -> String {
    format!(
        "{hash}\u{0}{short}\u{0}{parents}\u{0}{refs}\u{0}{author}\u{0}{date}\u{0}{subject}\u{1e}"
    )
}

#[test]
fn test_parse_git_log_linear() {
    let out = format!(
        "{}\n{}",
        log_record(
            "a1b2c3d4e5f6",
            "a1b2c3d",
            "00ff11ee22dd",
            "HEAD -> main",
            "Ada",
            "2026-05-30T10:00:00+00:00",
            "second commit",
        ),
        log_record(
            "00ff11ee22dd",
            "00ff11e",
            "",
            "",
            "Ada",
            "2026-05-29T09:00:00+00:00",
            "first commit",
        ),
    );
    let commits = parse_git_log(&out);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].hash, "a1b2c3d4e5f6");
    assert_eq!(commits[0].short_hash, "a1b2c3d");
    assert_eq!(commits[0].parents, vec!["00ff11ee22dd".to_string()]);
    assert_eq!(commits[0].refs, vec!["HEAD -> main".to_string()]);
    assert_eq!(commits[0].author, "Ada");
    assert_eq!(commits[0].subject, "second commit");
    // Root commit has no parents.
    assert!(commits[1].parents.is_empty());
    assert!(commits[1].refs.is_empty());
}

#[test]
fn test_parse_git_log_merge_multiple_parents() {
    let out = log_record(
        "merge00",
        "merge00",
        "parentA1 parentB2",
        "",
        "Ada",
        "2026-05-30T12:00:00+00:00",
        "Merge branch 'feature'",
    );
    let commits = parse_git_log(&out);
    assert_eq!(commits.len(), 1);
    assert_eq!(
        commits[0].parents,
        vec!["parentA1".to_string(), "parentB2".to_string()]
    );
}

#[test]
fn test_parse_git_log_decorations() {
    // With --decorate=full the parser receives canonical ref names; it only
    // splits on ", " and leaves classification to the renderer.
    let out = log_record(
        "dec00",
        "dec00",
        "p0",
        "HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main",
        "Ada",
        "2026-05-30T12:00:00+00:00",
        "release",
    );
    let commits = parse_git_log(&out);
    assert_eq!(
        commits[0].refs,
        vec![
            "HEAD -> refs/heads/main".to_string(),
            "tag: refs/tags/v1.0".to_string(),
            "refs/remotes/origin/main".to_string(),
        ]
    );
}

#[test]
fn test_parse_git_log_special_char_subject() {
    // Subject with pipes, spaces, and unicode must survive verbatim because
    // fields are NUL-delimited, not whitespace/pipe-delimited.
    let subject = "fix: a | b  with  spaces — café 🚀";
    let out = log_record(
        "sp00",
        "sp00",
        "p0",
        "",
        "Ada",
        "2026-05-30T12:00:00+00:00",
        subject,
    );
    let commits = parse_git_log(&out);
    assert_eq!(commits[0].subject, subject);
}

#[test]
fn test_parse_git_log_empty_input() {
    assert!(parse_git_log("").is_empty());
    assert!(parse_git_log("\n\n").is_empty());
}

#[test]
fn test_is_benign_log_failure() {
    // Expected empty-history states are benign.
    assert!(is_benign_log_failure(
        "fatal: your current branch 'main' does not have any commits yet"
    ));
    assert!(is_benign_log_failure(
        "fatal: not a git repository (or any of the parent directories): .git"
    ));
    assert!(is_benign_log_failure("fatal: bad default revision 'HEAD'"));
    assert!(is_benign_log_failure(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
    ));
    // Real failures must NOT be swallowed.
    assert!(!is_benign_log_failure(
        "error: object file .git/objects/ab/cd is empty"
    ));
    assert!(!is_benign_log_failure("fatal: unable to read tree"));
    assert!(!is_benign_log_failure(""));
}

#[test]
fn test_parse_git_log_skips_malformed_record() {
    // A record with too few fields is dropped; a valid one is kept.
    let out = format!(
        "not\u{0}enough\u{1e}{}",
        log_record(
            "ok00",
            "ok00",
            "",
            "",
            "Ada",
            "2026-05-30T12:00:00+00:00",
            "ok"
        )
    );
    let commits = parse_git_log(&out);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].hash, "ok00");
}

#[test]
fn test_parse_git_log_empty_subject_is_kept() {
    let out = log_record(
        "es00",
        "es00",
        "p0",
        "",
        "Ada",
        "2026-05-30T12:00:00+00:00",
        "",
    );
    let commits = parse_git_log(&out);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "");
}

#[test]
fn test_parse_git_log_ref_name_with_comma_is_one_chip() {
    // `%D` joins decorations with ", "; a ref whose name contains a comma
    // must stay one chip. Splitting on ", " (not bare ',') keeps it intact.
    let out = log_record(
        "rc00",
        "rc00",
        "p0",
        "HEAD -> main, tag: v1,2",
        "Ada",
        "2026-05-30T12:00:00+00:00",
        "x",
    );
    let commits = parse_git_log(&out);
    assert_eq!(
        commits[0].refs,
        vec!["HEAD -> main".to_string(), "tag: v1,2".to_string()]
    );
}

#[test]
fn test_parse_git_log_subject_with_embedded_nul_is_preserved() {
    // A stray NUL in the subject would create an 8th field; re-joining the
    // trailing fields keeps the subject whole instead of truncating it.
    let record =
        "h00\u{0}h00\u{0}p0\u{0}\u{0}Ada\u{0}2026-05-30T12:00:00+00:00\u{0}before\u{0}after\u{1e}";
    let commits = parse_git_log(record);
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "before\u{0}after");
}

// ========== Windows-specific tests for CWD dedupe and throttling ==========

#[cfg(target_os = "windows")]
#[test]
fn test_cwd_poll_state_new() {
    let state = CwdPollState::new();
    assert!(state.last_status.is_none());
    // New state should allow immediate poll (checked in past)
    let now = Instant::now();
    assert!(now.duration_since(state.last_checked) < Duration::from_secs(61));
}

#[cfg(target_os = "windows")]
#[test]
fn test_cwd_poll_state_default() {
    let state = CwdPollState::default();
    assert!(state.last_status.is_none());
}

#[test]
fn test_polling_guard_acquires_when_free() {
    let flag = Arc::new(AtomicBool::new(false));
    let guard = PollingGuard::new(flag.clone());
    assert!(guard.is_some());
    assert!(flag.load(Ordering::SeqCst)); // Flag should be set
}

#[test]
fn test_polling_guard_fails_when_locked() {
    let flag = Arc::new(AtomicBool::new(true));
    let guard = PollingGuard::new(flag.clone());
    assert!(guard.is_none());
    assert!(flag.load(Ordering::SeqCst)); // Flag should still be set
}

#[test]
fn test_polling_guard_resets_on_drop() {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let _guard = PollingGuard::new(flag.clone()).unwrap();
        assert!(flag.load(Ordering::SeqCst));
    }
    // After drop, flag should be reset
    assert!(!flag.load(Ordering::SeqCst));
}

#[test]
fn test_polling_guard_reset_after_early_return() {
    let flag = Arc::new(AtomicBool::new(false));
    let _result = (|| -> Option<()> {
        let _guard = PollingGuard::new(flag.clone())?;
        // Simulate early return
        None::<()>.or(Some(()))
    })();
    // Even with early return pattern, guard should clean up
    assert!(!flag.load(Ordering::SeqCst));
}

// Test deduplication helper: grouping terminals by CWD
#[test]
fn test_cwd_grouping_logic() {
    use std::collections::HashMap;
    let mut terminals: HashMap<String, String> = HashMap::new();
    terminals.insert("term-1".to_string(), "/home/user/repo".to_string());
    terminals.insert("term-2".to_string(), "/home/user/repo".to_string());
    terminals.insert("term-3".to_string(), "/home/user/other".to_string());

    let mut cwd_groups: HashMap<String, Vec<String>> = HashMap::new();
    for (id, cwd) in terminals.iter() {
        cwd_groups.entry(cwd.clone()).or_default().push(id.clone());
    }

    assert_eq!(cwd_groups.len(), 2);
    assert_eq!(cwd_groups.get("/home/user/repo").unwrap().len(), 2);
    assert_eq!(cwd_groups.get("/home/user/other").unwrap().len(), 1);
}

// Test throttling decision logic
#[cfg(target_os = "windows")]
#[test]
fn test_throttling_cooldown_with_status() {
    let mut state = CwdPollState::new();
    state.last_status = Some(GitStatus::new());
    state.last_checked = Instant::now();

    // Should be in cooldown immediately after poll with status
    assert!(
        Instant::now().duration_since(state.last_checked)
            < Duration::from_millis(STATUS_UNCHANGED_COOLDOWN_MS)
    );
}

#[cfg(target_os = "windows")]
#[test]
fn test_throttling_cooldown_without_status() {
    let mut state = CwdPollState::new();
    state.last_status = None; // No git repo or initial state
    state.last_checked = Instant::now();

    // Shorter cooldown when no status
    assert!(
        Instant::now().duration_since(state.last_checked) < Duration::from_millis(POLL_INTERVAL_MS)
    );
}

// ---- Integration tests for stage / unstage / discard against real repos ----

fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("termul-git-it-{tag}-{pid}-{n}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn git(cwd: &std::path::Path, args: &[&str]) -> std::process::Output {
    let out =
        GitTracker::run_git_command(cwd.to_str().unwrap(), args).expect("git command should run");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

/// Init a repo with deterministic identity. Returns the repo path.
fn init_repo(tag: &str) -> std::path::PathBuf {
    let dir = unique_temp_dir(tag);
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.email", "t@example.com"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    // Keep line endings byte-exact so content assertions are deterministic
    // across platforms (Windows git defaults can rewrite LF -> CRLF).
    git(&dir, &["config", "core.autocrlf", "false"]);
    dir
}

fn porcelain(cwd: &std::path::Path, path: &str) -> String {
    let out = git(cwd, &["status", "--porcelain", "--", path]);
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// Skip the test body (returning true) when git is unavailable in the env.
fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

#[test]
fn it_stage_then_unstage_modified_file_roundtrips() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-unstage");
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

    let cwd = repo.to_str().unwrap();
    git_stage_file(cwd, "a.txt").unwrap();
    assert!(
        porcelain(&repo, "a.txt").starts_with("M "),
        "should be staged"
    );

    git_unstage_file(cwd, "a.txt").unwrap();
    assert!(
        porcelain(&repo, "a.txt").starts_with(" M"),
        "should be unstaged but still modified"
    );
    std::fs::remove_dir_all(&repo).ok();
}

// Per-hunk stage/unstage round-trip + path-traversal guard (#257).
// The two-hunk setup proves partial staging: staging hunk 1 leaves
// hunk 2 in the working tree (unstaged), which file-level `git add`
// could never express.

/// Build a one-hunk patch fragment for `path` from a body (lines without
/// the `--- a/` / `+++ b/` header). A trailing newline terminates the last
/// body line, which `git apply` requires.
fn hunk_patch(path: &str, header: &str, body: &str) -> String {
    format!("--- a/{path}\n+++ b/{path}\n{header}\n{body}\n")
}

#[test]
fn it_stage_hunk_stages_only_that_hunk_leaving_others_unstaged() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-hunk-partial");
    // Two changes separated by an unchanged line produce two hunks.
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nFOUR\n").unwrap();

    let cwd = repo.to_str().unwrap();

    // Stage only the first hunk (one/two->TWO/three).
    let patch_hunk1 = hunk_patch("a.txt", "@@ -1,3 +1,3 @@", " one\n-two\n+TWO\n three");
    git_stage_hunk(cwd, "a.txt", &patch_hunk1).unwrap();

    // Staging hunk 1 must put +TWO into the index but leave hunk 2
    // (four -> FOUR) entirely in the working tree. Context lines such
    // as ` TWO` can appear on both sides unchanged, so we assert on the
    // addition/deletion markers, not bare substrings.
    let staged = git_get_diff(cwd, "a.txt", true).unwrap();
    let unstaged = git_get_diff(cwd, "a.txt", false).unwrap();
    assert!(
        staged.contains("+TWO") && staged.contains("-two"),
        "staged diff should include hunk 1's add/remove:\n{staged}"
    );
    assert!(
        !staged.contains("FOUR"),
        "staged must not include hunk 2:\n{staged}"
    );
    assert!(
        unstaged.contains("+FOUR") && unstaged.contains("-four"),
        "unstaged diff should still include hunk 2:\n{unstaged}"
    );
    assert!(
        !unstaged.contains("-two\n") && !unstaged.contains("+TWO\n"),
        "unstaged must not re-show hunk 1 as a change:\n{unstaged}"
    );
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_unstage_hunk_reverses_a_previously_staged_hunk() {
    if git_missing() {
        return;
    }
    let repo = init_repo("unstage-hunk");
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\n").unwrap();

    let cwd = repo.to_str().unwrap();
    let patch = hunk_patch("a.txt", "@@ -1,2 +1,2 @@", " one\n-two\n+TWO");

    git_stage_hunk(cwd, "a.txt", &patch).unwrap();
    assert!(git_get_diff(cwd, "a.txt", true).unwrap().contains("TWO"));

    // Reverse-applying the same staged-side patch removes it from the index.
    git_unstage_hunk(cwd, "a.txt", &patch).unwrap();
    assert!(
        git_get_diff(cwd, "a.txt", true).unwrap().trim().is_empty(),
        "staged diff should be empty after unstaging the hunk"
    );
    // Working tree is untouched.
    assert!(git_get_diff(cwd, "a.txt", false).unwrap().contains("TWO"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_stage_hunk_rejects_patch_whose_header_targets_a_different_path() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-hunk-guard");
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();

    let cwd = repo.to_str().unwrap();
    // Patch header lies about the path: claims secret.txt while caller
    // asks to stage a.txt. The guard must refuse (path-traversal defense).
    let lying_patch = "--- a/secret.txt\n+++ b/secret.txt\n@@ -1,1 +1,1 @@\n-one\n+two";
    let err = git_stage_hunk(cwd, "a.txt", lying_patch).unwrap_err();
    assert!(
        err.contains("does not match"),
        "expected path-mismatch error, got: {err}"
    );
    // Nothing was staged.
    assert!(git_get_diff(cwd, "a.txt", true).unwrap().trim().is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_stage_hunk_rejects_unsafe_expected_path() {
    // No repo needed: the guard runs before any git invocation.
    let patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b";
    let err = git_stage_hunk(".", "../escape.txt", patch).unwrap_err();
    assert!(
        err.contains("unsafe path"),
        "expected unsafe-path error, got: {err}"
    );
}

// CodeRabbit review feedback: `git apply -p1` strips the first path
// component regardless of its name, so a header using a non-standard
// prefix (e.g. `c/`) must be validated exactly like `a/` / `b/`. Without
// this, `+++ c/../../etc/passwd` would bypass the old `+++ b/`-only check.
#[test]
fn it_stage_hunk_rejects_non_standard_prefix_attempting_traversal() {
    let patch = "--- c/foo.txt\n+++ c/../../etc/passwd\n@@ -1,1 +1,1 @@\n-a\n+b";
    let err = git_stage_hunk(".", "foo.txt", patch).unwrap_err();
    assert!(
        err.contains("does not match"),
        "expected path-mismatch error for non-standard prefix, got: {err}"
    );
}

#[test]
fn it_stage_hunk_rejects_patch_missing_a_header() {
    // Both `--- ` and `+++ ` are required. A headerless fragment could
    // otherwise hide which file `git apply` targets.
    let patch = "@@ -1,1 +1,1 @@\n-a\n+b";
    let err = git_stage_hunk(".", "foo.txt", patch).unwrap_err();
    assert!(
        err.contains("missing"),
        "expected missing-header error, got: {err}"
    );
}

// CodeRabbit review (2nd round): a hunk body line that looks like a file
// header (deleting `-- comment` → diff line `--- comment`) must be
// consumed as body content per the @@ budget, not rejected as a header.
#[test]
fn validate_accepts_body_line_that_looks_like_a_header() {
    let patch = "--- a/foo.sql\n+++ b/foo.sql\n@@ -1,2 +1,2 @@\n ctx\n--- comment\n+-- new";
    assert!(
        validate_hunk_patch_paths("foo.sql", patch).is_ok(),
        "body line `--- comment` must be consumed as content, not treated as a header"
    );
}

// The body-budget walk must still reject a second file section that
// appears after a hunk's declared body is consumed (multi-file injection
// into `git apply --cached`). This is the traversal defense the prior
// review round asked us not to regress.
#[test]
fn validate_rejects_second_file_section_after_hunk_body() {
    let patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/other.txt\n+++ b/other.txt\n@@ -1,1 +1,1 @@\n-c\n+d";
    let err = validate_hunk_patch_paths("foo.txt", patch).unwrap_err();
    assert!(
        err.contains("does not match"),
        "multi-file injection after hunk body must be rejected, got: {err}"
    );
}

#[test]
fn it_unstage_preserves_worktree_on_staged_modified_file() {
    if git_missing() {
        return;
    }
    let repo = init_repo("unstage-preserve");
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]);

    // Unstage must NOT delete or revert the working-tree content.
    git_unstage_file(repo.to_str().unwrap(), "a.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "changed\n"
    );
    assert!(porcelain(&repo, "a.txt").starts_with(" M"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_unstage_no_head_repo_removes_from_index_keeps_file() {
    if git_missing() {
        return;
    }
    let repo = init_repo("unstage-nohead");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]); // staged-added, no commit -> no HEAD
    assert!(!repo_has_head(repo.to_str().unwrap()));

    git_unstage_file(repo.to_str().unwrap(), "a.txt").unwrap();
    // File stays on disk, now untracked.
    assert!(repo.join("a.txt").exists());
    assert!(porcelain(&repo, "a.txt").starts_with("??"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_reverts_tracked_modification_to_index() {
    if git_missing() {
        return;
    }
    let repo = init_repo("discard-modified");
    std::fs::write(repo.join("a.txt"), "orig\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();

    git_discard_file(repo.to_str().unwrap(), "a.txt").unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "orig\n"
    );
    assert!(porcelain(&repo, "a.txt").is_empty(), "clean after discard");
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_staged_row_of_mm_file_preserves_staged_content() {
    if git_missing() {
        return;
    }
    // MM: staged edit + further worktree edit. Discard reverts the worktree
    // to the index and must keep the staged edit intact.
    let repo = init_repo("discard-mm");
    std::fs::write(repo.join("a.txt"), "orig\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "staged\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]);
    std::fs::write(repo.join("a.txt"), "staged-plus-worktree\n").unwrap();
    assert!(porcelain(&repo, "a.txt").starts_with("MM"));

    git_discard_file(repo.to_str().unwrap(), "a.txt").unwrap();
    // Worktree reverts to the staged (index) version, not HEAD.
    assert_eq!(
        std::fs::read_to_string(repo.join("a.txt")).unwrap(),
        "staged\n"
    );
    assert!(porcelain(&repo, "a.txt").starts_with("M "));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_untracked_file_deletes_it() {
    if git_missing() {
        return;
    }
    let repo = init_repo("discard-untracked");
    std::fs::write(repo.join("n.txt"), "new\n").unwrap();
    assert!(porcelain(&repo, "n.txt").starts_with("??"));

    git_discard_file(repo.to_str().unwrap(), "n.txt").unwrap();
    assert!(!repo.join("n.txt").exists());
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_untracked_directory_deletes_it() {
    if git_missing() {
        return;
    }
    let repo = init_repo("discard-untracked-dir");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    std::fs::write(repo.join("sub/inner.txt"), "x\n").unwrap();
    // Porcelain collapses the untracked dir to "?? sub/".
    assert!(porcelain(&repo, "sub").starts_with("??"));

    git_discard_file(repo.to_str().unwrap(), "sub").unwrap();
    assert!(!repo.join("sub").exists());
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_whole_repo_pathspec_is_refused() {
    if git_missing() {
        return;
    }
    // F-006: `path: "."` classified as untracked (any `??` entry in the
    // status output) must be REFUSED, not `remove_dir_all` the repo incl
    // `.git`. The discard contract is a single-file op.
    let repo = init_repo("discard-whole-repo");
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    assert!(porcelain(&repo, ".").starts_with("??"));

    let err = git_discard_file(repo.to_str().unwrap(), ".")
        .expect_err("whole-repo discard must be refused");
    assert!(err.contains("Refusing to delete unsafe path"));
    // The repo — including .git and every file — must survive intact.
    assert!(repo.join(".git").is_dir());
    assert!(repo.join("a.txt").is_file());
    assert!(repo.join("b.txt").is_file());
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_discard_already_missing_untracked_is_ok() {
    if git_missing() {
        return;
    }
    let repo = init_repo("discard-missing");
    // No such file; classified clean -> Noop, must not error.
    git_discard_file(repo.to_str().unwrap(), "ghost.txt").unwrap();
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_git_get_log_empty_repo_is_empty() {
    if git_missing() {
        return;
    }
    // A freshly-init'd repo has no commits; git log exits non-zero and we
    // must surface an empty list instead of an error.
    let repo = init_repo("log-empty");
    let commits = git_get_log(repo.to_str().unwrap(), None).unwrap();
    assert!(commits.is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_git_get_log_reads_linear_history_newest_first() {
    if git_missing() {
        return;
    }
    let repo = init_repo("log-linear");
    std::fs::write(repo.join("a.txt"), "1\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "first commit"]);
    std::fs::write(repo.join("a.txt"), "2\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "second | commit"]);

    let commits = git_get_log(repo.to_str().unwrap(), None).unwrap();
    assert_eq!(commits.len(), 2);
    // Newest first; subject with a pipe survives intact.
    assert_eq!(commits[0].subject, "second | commit");
    assert_eq!(commits[1].subject, "first commit");
    // The newer commit's first parent is the older commit.
    assert_eq!(commits[0].parents, vec![commits[1].hash.clone()]);
    // Root commit has no parents.
    assert!(commits[1].parents.is_empty());
    // HEAD decoration is present somewhere on the tip.
    assert!(commits[0].refs.iter().any(|r| r.contains("HEAD")));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_git_get_log_captures_merge_parents() {
    if git_missing() {
        return;
    }
    let repo = init_repo("log-merge");
    let cwd = repo.to_str().unwrap();
    std::fs::write(repo.join("a.txt"), "base\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "base"]);
    // Create a feature branch with its own commit.
    git(&repo, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.join("b.txt"), "feat\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "feature work"]);
    // Diverge main.
    git(&repo, &["checkout", "-q", "-"]); // back to default branch
    std::fs::write(repo.join("c.txt"), "main\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "main work"]);
    // Force a merge commit (no fast-forward).
    git(
        &repo,
        &["merge", "--no-ff", "-q", "-m", "Merge feature", "feature"],
    );

    let commits = git_get_log(cwd, None).unwrap();
    let merge = commits
        .iter()
        .find(|c| c.subject == "Merge feature")
        .expect("merge commit present");
    assert!(
        merge.parents.len() >= 2,
        "merge should have >= 2 parents, got {:?}",
        merge.parents
    );
    std::fs::remove_dir_all(&repo).ok();
}

// ---- commit / amend / push / context ----

fn last_subject(repo: &std::path::Path) -> String {
    let out = git(repo, &["log", "-1", "--pretty=%s"]);
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn last_body(repo: &std::path::Path) -> String {
    let out = git(repo, &["log", "-1", "--pretty=%b"]);
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn count_commits(repo: &std::path::Path) -> usize {
    let out = git(repo, &["rev-list", "--count", "HEAD"]);
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

#[test]
fn it_checkout_and_create_branch() {
    if git_missing() {
        return;
    }
    let repo = init_repo("checkout-branch");
    let cwd = repo.to_str().unwrap();
    std::fs::write(repo.join("a.txt"), "base\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "base"]);

    let default_branch = String::from_utf8_lossy(&git(&repo, &["branch", "--show-current"]).stdout)
        .trim()
        .to_string();

    git_create_branch(cwd, "feature/test", None).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&git(&repo, &["branch", "--show-current"]).stdout).trim(),
        "feature/test"
    );

    git_checkout_branch(cwd, &default_branch, false).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&git(&repo, &["branch", "--show-current"]).stdout).trim(),
        default_branch
    );

    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_build_commit_message_formats_body() {
    assert_eq!(build_commit_message("hello", ""), "hello");
    assert_eq!(build_commit_message("  hello  ", "  "), "hello");
    assert_eq!(
        build_commit_message("summary", "more detail"),
        "summary\n\nmore detail"
    );
}

#[test]
fn it_commit_creates_commit_and_clears_index() {
    if git_missing() {
        return;
    }
    let repo = init_repo("commit-basic");
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]);

    let cwd = repo.to_str().unwrap();
    git_commit_file(cwd, "second commit", "", false).unwrap();

    assert_eq!(count_commits(&repo), 2);
    assert_eq!(last_subject(&repo), "second commit");
    assert_eq!(
        staged_entry_count(cwd),
        Some(0),
        "index cleared after commit"
    );
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_git_get_log_respects_limit() {
    if git_missing() {
        return;
    }
    let repo = init_repo("log-limit");
    for i in 0..5 {
        std::fs::write(repo.join("a.txt"), format!("{i}\n")).unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", &format!("commit {i}")]);
    }
    let commits = git_get_log(repo.to_str().unwrap(), Some(3)).unwrap();
    assert_eq!(commits.len(), 3);
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_commit_writes_multiline_body() {
    if git_missing() {
        return;
    }
    let repo = init_repo("commit-body");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]);

    git_commit_file(repo.to_str().unwrap(), "sum", "line one\nline two", false).unwrap();
    assert_eq!(last_subject(&repo), "sum");
    assert_eq!(last_body(&repo), "line one\nline two");
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_commit_rejects_empty_summary() {
    if git_missing() {
        return;
    }
    let repo = init_repo("commit-emptysum");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]);
    let err = git_commit_file(repo.to_str().unwrap(), "   ", "", false).unwrap_err();
    assert!(err.to_lowercase().contains("summary"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_commit_rejects_nothing_staged() {
    if git_missing() {
        return;
    }
    let repo = init_repo("commit-nostage");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    // Clean index now.
    let err = git_commit_file(repo.to_str().unwrap(), "noop", "", false).unwrap_err();
    assert!(err.to_lowercase().contains("nothing staged"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_amend_rewords_subject_without_new_commit() {
    if git_missing() {
        return;
    }
    let repo = init_repo("amend-reword");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "original"]);
    assert_eq!(count_commits(&repo), 1);

    git_commit_file(repo.to_str().unwrap(), "reworded", "", true).unwrap();
    assert_eq!(count_commits(&repo), 1, "amend must not add a commit");
    assert_eq!(last_subject(&repo), "reworded");
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_amend_folds_staged_changes() {
    if git_missing() {
        return;
    }
    let repo = init_repo("amend-fold");
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("b.txt"), "new\n").unwrap();
    git(&repo, &["add", "--", "b.txt"]);

    let cwd = repo.to_str().unwrap();
    git_commit_file(cwd, "init+b", "", true).unwrap();
    assert_eq!(count_commits(&repo), 1);
    // b.txt is now part of HEAD; nothing left staged.
    assert_eq!(staged_entry_count(cwd), Some(0));
    let tree = git(&repo, &["ls-tree", "--name-only", "HEAD"]);
    let names = String::from_utf8_lossy(&tree.stdout);
    assert!(names.contains("b.txt"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_amend_rejects_no_head() {
    if git_missing() {
        return;
    }
    let repo = init_repo("amend-nohead");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "--", "a.txt"]); // staged, but no commit yet
    let err = git_commit_file(repo.to_str().unwrap(), "x", "", true).unwrap_err();
    assert!(err.to_lowercase().contains("no commit to amend"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_push_sets_upstream_and_resets_ahead() {
    if git_missing() {
        return;
    }
    let repo = init_repo("push-upstream");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);

    // Local bare remote -> no network.
    let bare = unique_temp_dir("push-bare");
    git(&bare, &["init", "--bare", "-q"]);
    let bare_str = bare.to_str().unwrap();
    git(&repo, &["remote", "add", "origin", bare_str]);

    let cwd = repo.to_str().unwrap();
    // No upstream yet -> push must set it.
    git_push_current(cwd).unwrap();

    let ctx = git_get_commit_context(cwd).unwrap();
    assert!(ctx.has_upstream, "upstream should be set after publish");
    assert_eq!(ctx.ahead, 0, "ahead resets after push");

    // A further commit is ahead; push again brings it back to 0.
    std::fs::write(repo.join("a.txt"), "y\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "second"]);
    assert_eq!(git_get_commit_context(cwd).unwrap().ahead, 1);
    git_push_current(cwd).unwrap();
    assert_eq!(git_get_commit_context(cwd).unwrap().ahead, 0);

    std::fs::remove_dir_all(&repo).ok();
    std::fs::remove_dir_all(&bare).ok();
}

#[test]
fn it_push_rejects_detached_head() {
    if git_missing() {
        return;
    }
    let repo = init_repo("push-detached");
    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    git(&repo, &["checkout", "-q", &sha]); // detach

    let err = git_push_current(repo.to_str().unwrap()).unwrap_err();
    assert!(err.to_lowercase().contains("branch"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn it_commit_context_reports_fields() {
    if git_missing() {
        return;
    }
    let repo = init_repo("ctx-basic");
    let cwd = repo.to_str().unwrap();

    // No HEAD yet.
    let empty = git_get_commit_context(cwd).unwrap();
    assert!(!empty.has_head);
    assert_eq!(empty.staged_count, 0);
    assert!(empty.last_subject.is_empty());

    std::fs::write(repo.join("a.txt"), "x\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "first\n\nbody text"]);
    std::fs::write(repo.join("b.txt"), "y\n").unwrap();
    git(&repo, &["add", "--", "b.txt"]);

    let ctx = git_get_commit_context(cwd).unwrap();
    assert!(ctx.has_head);
    assert!(ctx.branch.is_some());
    assert!(!ctx.has_upstream);
    assert_eq!(ctx.staged_count, 1);
    assert_eq!(ctx.last_subject, "first");
    assert_eq!(ctx.last_body, "body text");
    std::fs::remove_dir_all(&repo).ok();
}
