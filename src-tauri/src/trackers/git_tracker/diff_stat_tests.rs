use super::diff_stat::{
    count_lines, parse_numstat_files, probe_head, untracked_file_stats, GitFileDiffStat,
    MAX_UNTRACKED_FILES, MAX_UNTRACKED_FILE_BYTES,
};
use super::git_exec::GitRunError;
use super::*;
use std::sync::atomic::AtomicU32;

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

/// Temp directory removed on drop, so tests never leak repos (or the 2 MiB
/// oversize fixture) even when an assertion fails.
struct TestDir(std::path::PathBuf);

impl std::ops::Deref for TestDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unique_temp_dir(tag: &str) -> TestDir {
    let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "termul-diffstat-{tag}-{}-{n}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    TestDir(dir)
}

fn git(cwd: &std::path::Path, args: &[&str]) {
    let out =
        GitTracker::run_git_command(cwd.to_str().unwrap(), args).expect("git command should run");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo(tag: &str) -> TestDir {
    let dir = unique_temp_dir(tag);
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.email", "t@example.com"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    dir
}

fn commit_all(repo: &std::path::Path) {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", "base"]);
}

fn write(repo: &std::path::Path, rel: &str, contents: &[u8]) {
    let path = repo.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, contents).expect("write file");
}

/// Totals only; per-file rows are checked by the `files` tests.
fn stat(repo: &std::path::Path) -> GitDiffStat {
    let stat = git_get_diff_stat(repo.to_str().unwrap()).expect("diff stat");
    GitDiffStat {
        files: Vec::new(),
        root: String::new(),
        ..stat
    }
}

fn files(repo: &std::path::Path) -> Vec<GitFileDiffStat> {
    git_get_diff_stat(repo.to_str().unwrap())
        .expect("diff stat")
        .files
}

fn file(path: &str, added: u64, removed: u64) -> GitFileDiffStat {
    GitFileDiffStat {
        path: path.to_string(),
        added,
        removed,
    }
}

fn untracked_total(toplevel: &std::path::Path, listing: &[u8]) -> u64 {
    untracked_file_stats(toplevel, listing)
        .iter()
        .map(|f| f.added)
        .sum()
}

fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

// ---- pure helpers ----

#[test]
fn parse_numstat_files_lists_rows_and_zeroes_binary() {
    let out = "3\t1\tsrc/a.rs\x0010\t0\tb.txt\x00-\t-\timage.png\x00";
    assert_eq!(
        parse_numstat_files(out),
        vec![
            file("b.txt", 10, 0),
            file("image.png", 0, 0),
            file("src/a.rs", 3, 1)
        ]
    );
}

#[test]
fn parse_numstat_files_keys_a_rename_by_its_new_path() {
    let out = "2\t1\t\x00old/name.rs\x00new/name.rs\x00";
    assert_eq!(parse_numstat_files(out), vec![file("new/name.rs", 2, 1)]);
}

#[test]
fn parse_numstat_files_handles_empty_input() {
    assert_eq!(parse_numstat_files(""), Vec::new());
}

#[test]
fn count_lines_counts_final_line_without_newline() {
    assert_eq!(count_lines(b""), 0);
    assert_eq!(count_lines(b"\n"), 1);
    assert_eq!(count_lines(b"a"), 1);
    assert_eq!(count_lines(b"a\n"), 1);
    assert_eq!(count_lines(b"a\nb"), 2);
    assert_eq!(count_lines(b"a\r\nb\r\n"), 2);
    assert_eq!(count_lines(b"a\n\nb\n"), 3);
}

#[test]
fn count_untracked_lines_skips_binary_missing_and_directories() {
    let dir = unique_temp_dir("count-skips");
    write(&dir, "text.txt", b"a\nb\nc\n");
    write(&dir, "bin.dat", b"ab\0cd\nmore\n");
    write(&dir, "sub/nested.txt", b"x\ny");
    let listing = b"text.txt\0bin.dat\0missing.txt\0sub\0sub/nested.txt\0";
    assert_eq!(untracked_total(&dir, listing), 3 + 2);
}

#[test]
fn count_untracked_lines_skips_oversized_files() {
    let dir = unique_temp_dir("count-oversize");
    write(&dir, "small.txt", b"1\n2\n");
    let big = vec![b'\n'; (MAX_UNTRACKED_FILE_BYTES + 1) as usize];
    write(&dir, "big.txt", &big);
    assert_eq!(untracked_total(&dir, b"small.txt\0big.txt\0"), 2);
}

#[test]
fn count_untracked_lines_caps_file_count() {
    let dir = unique_temp_dir("count-filecap");
    write(&dir, "one.txt", b"a\n");
    let mut listing = Vec::new();
    for _ in 0..MAX_UNTRACKED_FILES {
        listing.extend_from_slice(b"one.txt\0");
    }
    // Entries past the cap are never read.
    listing.extend_from_slice(b"one.txt\0one.txt\0");
    assert_eq!(untracked_total(&dir, &listing), MAX_UNTRACKED_FILES as u64);
}

#[cfg(unix)]
#[test]
fn count_untracked_lines_never_follows_symlinks() {
    let dir = unique_temp_dir("count-symlink");
    write(&dir, "target.txt", b"a\nb\nc\n");
    std::os::unix::fs::symlink(dir.join("target.txt"), dir.join("link.txt")).expect("symlink");
    assert_eq!(untracked_total(&dir, b"link.txt\0"), 0);
}

#[test]
fn diff_stat_error_has_stable_code() {
    let e = DiffStatError::from(GitRunError::GitFailed {
        command: "diff",
        detail: "boom".to_string(),
    });
    assert_eq!(e.code(), "GIT_DIFF_STAT_ERROR");
    assert_eq!(e.to_string(), "git diff failed: boom");
    assert_eq!(
        DiffStatError::from(GitRunError::GitUnavailable("x".to_string())).code(),
        "GIT_DIFF_STAT_ERROR"
    );
}

#[test]
fn diff_stat_serializes_camel_case() {
    let json = serde_json::to_value(GitDiffStat {
        added: 2,
        removed: 1,
        files: vec![file("a.txt", 2, 1)],
        root: "/repo".to_string(),
    })
    .expect("serialize");
    assert_eq!(
        json,
        serde_json::json!({
            "added": 2,
            "removed": 1,
            "files": [{ "path": "a.txt", "added": 2, "removed": 1 }],
            "root": "/repo"
        })
    );
}

// ---- service (temp git repos) ----

#[test]
fn it_clean_repo_is_zero() {
    if git_missing() {
        return;
    }
    let repo = init_repo("clean");
    write(&repo, "a.txt", b"one\ntwo\n");
    commit_all(&repo);
    assert_eq!(stat(&repo), GitDiffStat::default());
}

#[test]
fn it_tracked_edits_count_added_and_removed() {
    if git_missing() {
        return;
    }
    let repo = init_repo("tracked");
    write(&repo, "a.txt", b"l1\nl2\nl3\nl4\n");
    commit_all(&repo);
    // 3 lines added, 1 removed (l2 deleted; three appended).
    write(&repo, "a.txt", b"l1\nl3\nl4\nn1\nn2\nn3\n");
    assert_eq!(
        stat(&repo),
        GitDiffStat {
            added: 3,
            removed: 1,
            files: Vec::new(),
            root: String::new()
        }
    );
}

#[test]
fn it_staged_edits_are_counted_like_unstaged() {
    if git_missing() {
        return;
    }
    let repo = init_repo("staged");
    write(&repo, "a.txt", b"l1\nl2\nl3\nl4\n");
    commit_all(&repo);
    write(&repo, "a.txt", b"l1\nl3\nl4\nn1\nn2\nn3\n");
    git(&repo, &["add", "a.txt"]);
    assert_eq!(
        stat(&repo),
        GitDiffStat {
            added: 3,
            removed: 1,
            files: Vec::new(),
            root: String::new()
        }
    );
}

#[test]
fn it_untracked_file_counts_final_line_without_newline() {
    if git_missing() {
        return;
    }
    let repo = init_repo("untracked");
    write(&repo, "base.txt", b"x\n");
    commit_all(&repo);
    write(&repo, "new.txt", b"1\n2\n3\n4\n5");
    assert_eq!(
        stat(&repo),
        GitDiffStat {
            added: 5,
            removed: 0,
            files: Vec::new(),
            root: String::new()
        }
    );
}

#[test]
fn it_mixed_tracked_and_untracked_sum() {
    if git_missing() {
        return;
    }
    let repo = init_repo("mixed");
    write(&repo, "a.txt", b"l1\nl2\n");
    commit_all(&repo);
    write(&repo, "a.txt", b"l1\nl2\nl3\n");
    write(&repo, "new.txt", b"a\nb\n");
    assert_eq!(
        stat(&repo),
        GitDiffStat {
            added: 3,
            removed: 0,
            files: Vec::new(),
            root: String::new()
        }
    );
}

#[test]
fn it_ignored_and_binary_files_contribute_zero() {
    if git_missing() {
        return;
    }
    let repo = init_repo("ignored-binary");
    write(&repo, ".gitignore", b"ignored.txt\n");
    write(&repo, "bin.dat", b"\0\x01\x02\n\x03\n");
    commit_all(&repo);
    write(&repo, "ignored.txt", b"a\nb\nc\n");
    write(&repo, "untracked.bin", b"\0\0\0\n\n\n");
    // Tracked binary edit: numstat reports `-\t-`.
    write(&repo, "bin.dat", b"\0\x09\n\x08\n\x07\n");
    assert_eq!(stat(&repo), GitDiffStat::default());
}

#[test]
fn it_no_head_counts_against_empty_tree() {
    if git_missing() {
        return;
    }
    let repo = init_repo("no-head");
    write(&repo, "staged.txt", b"s1\ns2\n");
    git(&repo, &["add", "staged.txt"]);
    write(&repo, "untracked.txt", b"u1\nu2\nu3\n");
    assert_eq!(
        stat(&repo),
        GitDiffStat {
            added: 5,
            removed: 0,
            files: Vec::new(),
            root: String::new()
        }
    );
}

#[test]
fn it_subdirectory_cwd_reports_repo_wide_stat() {
    if git_missing() {
        return;
    }
    let repo = init_repo("subdir");
    write(&repo, "a.txt", b"l1\n");
    write(&repo, "sub/b.txt", b"l1\n");
    commit_all(&repo);
    write(&repo, "a.txt", b"l1\nl2\n");
    write(&repo, "top-untracked.txt", b"x\ny\n");
    write(&repo, "sub/sub-untracked.txt", b"z\n");
    assert_eq!(
        stat(&repo.join("sub")),
        GitDiffStat {
            added: 4,
            removed: 0,
            files: Vec::new(),
            root: String::new()
        }
    );
    assert_eq!(
        files(&repo.join("sub")),
        vec![
            file("a.txt", 1, 0),
            file("sub/sub-untracked.txt", 1, 0),
            file("top-untracked.txt", 2, 0)
        ]
    );
}

#[test]
fn it_files_list_each_changed_file_against_head() {
    if git_missing() {
        return;
    }
    let repo = init_repo("files");
    write(&repo, "a.txt", b"l1\nl2\nl3\nl4\n");
    write(&repo, "gone.txt", b"x\ny\n");
    commit_all(&repo);
    write(&repo, "a.txt", b"l1\nl3\nl4\nn1\nn2\nn3\n");
    git(&repo, &["add", "a.txt"]);
    std::fs::remove_file(repo.join("gone.txt")).expect("remove");
    write(&repo, "new.txt", b"1\n2");
    assert_eq!(
        files(&repo),
        vec![
            file("a.txt", 3, 1),
            file("gone.txt", 0, 2),
            file("new.txt", 2, 0)
        ]
    );
}

#[test]
fn it_files_are_empty_after_commit_and_discard() {
    if git_missing() {
        return;
    }
    let repo = init_repo("files-clean");
    write(&repo, "a.txt", b"one\n");
    write(&repo, "b.txt", b"one\n");
    commit_all(&repo);
    write(&repo, "a.txt", b"one\ntwo\n");
    write(&repo, "b.txt", b"one\nthree\n");
    write(&repo, "scratch.txt", b"tmp\n");
    assert_eq!(files(&repo).len(), 3);

    git(&repo, &["commit", "-q", "-am", "a and b"]);
    std::fs::remove_file(repo.join("scratch.txt")).expect("remove");
    assert_eq!(files(&repo), Vec::new());

    write(&repo, "a.txt", b"changed\n");
    git(&repo, &["checkout", "--", "a.txt"]);
    assert_eq!(files(&repo), Vec::new());
}

#[test]
fn it_files_stay_repo_root_relative_when_diff_relative_is_set() {
    if git_missing() {
        return;
    }
    let repo = init_repo("files-diff-relative");
    write(&repo, "a.txt", b"l1\n");
    write(&repo, "sub/b.txt", b"l1\n");
    commit_all(&repo);
    git(&repo, &["config", "diff.relative", "true"]);
    write(&repo, "a.txt", b"l1\nl2\n");
    write(&repo, "sub/b.txt", b"l1\nl2\n");
    assert_eq!(
        files(&repo.join("sub")),
        vec![file("a.txt", 1, 0), file("sub/b.txt", 1, 0)]
    );
}

#[test]
fn it_reports_the_repository_root_for_a_subdirectory_cwd() {
    if git_missing() {
        return;
    }
    let repo = init_repo("root");
    write(&repo, "sub/b.txt", b"l1\n");
    commit_all(&repo);
    let stat = git_get_diff_stat(repo.join("sub").to_str().unwrap()).expect("diff stat");
    assert_eq!(
        std::fs::canonicalize(&stat.root).expect("root exists"),
        std::fs::canonicalize(&*repo).expect("repo exists")
    );
}

#[test]
fn it_not_a_repo_is_a_diff_stat_error() {
    if git_missing() {
        return;
    }
    let dir = unique_temp_dir("not-a-repo");
    let err = git_get_diff_stat(dir.to_str().unwrap()).expect_err("not a repo must fail");
    assert_eq!(err.code(), "GIT_DIFF_STAT_ERROR");
}

#[test]
fn it_missing_cwd_is_a_diff_stat_error() {
    let parent = unique_temp_dir("missing-parent");
    let dir = parent.join("does-not-exist");
    let err = git_get_diff_stat(dir.to_str().unwrap()).expect_err("missing cwd must fail");
    assert_eq!(err.code(), "GIT_DIFF_STAT_ERROR");
}

// ---- HEAD probe: only "no HEAD" selects the empty tree ----

#[test]
fn probe_head_reports_unborn_and_born_heads() {
    if git_missing() {
        return;
    }
    let repo = init_repo("probe-head");
    assert!(!probe_head(repo.to_str().unwrap()).expect("probe on unborn HEAD"));
    write(&repo, "a.txt", b"one\n");
    commit_all(&repo);
    assert!(probe_head(repo.to_str().unwrap()).expect("probe on born HEAD"));
}

#[test]
fn probe_head_non_repo_is_git_failed_not_no_head() {
    if git_missing() {
        return;
    }
    let dir = unique_temp_dir("probe-not-a-repo");
    let err = probe_head(dir.to_str().unwrap()).expect_err("non-repo probe must fail");
    assert!(matches!(err, GitRunError::GitFailed { .. }), "{err:?}");
}

#[test]
fn probe_head_spawn_failure_is_git_unavailable() {
    let parent = unique_temp_dir("probe-missing");
    let dir = parent.join("does-not-exist");
    let err = probe_head(dir.to_str().unwrap()).expect_err("missing cwd must fail");
    assert!(matches!(err, GitRunError::GitUnavailable(_)), "{err:?}");
}

#[test]
fn it_broken_object_store_is_an_error_not_an_empty_tree_stat() {
    if git_missing() {
        return;
    }
    let repo = init_repo("broken-head");
    write(&repo, "a.txt", b"one\ntwo\n");
    commit_all(&repo);
    // Corrupt the object store so the probe and diff cannot succeed: the stat
    // must fail instead of silently counting existing content as additions.
    std::fs::remove_dir_all(repo.join(".git").join("objects")).expect("remove objects");
    assert!(git_get_diff_stat(repo.to_str().unwrap()).is_err());
}
