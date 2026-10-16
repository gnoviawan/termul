use super::commit_detail::GitCommitFileStatus;
use super::commit_detail::{
    is_commit_hash, is_object_id, merge_file_lists, parse_name_status_z, parse_numstat_z,
    parse_show_header, MAX_COMMIT_FILES, MAX_FILE_DIFF_BYTES,
};
use super::git_exec::GitRunError;
use super::*;
use std::sync::atomic::AtomicU32;

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

/// Temp directory removed on drop, so tests never leak repos.
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
        "termul-commitdetail-{tag}-{}-{n}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    TestDir(dir)
}

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    // Longer than the 2s poll default: `add`/`commit` of ~1000 files can
    // outlast it on a loaded CI machine.
    let out = GitTracker::run_git_command_with_timeout(cwd.to_str().unwrap(), args, 30_000)
        .expect("git command should run");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(tag: &str) -> TestDir {
    let dir = unique_temp_dir(tag);
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "t@example.com"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "commit.gpgsign", "false"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    dir
}

fn write(repo: &std::path::Path, rel: &str, contents: &[u8]) {
    let path = repo.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, contents).expect("write file");
}

fn commit(repo: &std::path::Path, message: &str) -> String {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-q", "-m", message]);
    git(repo, &["rev-parse", "HEAD"])
}

fn detail(repo: &std::path::Path, hash: &str) -> GitCommitDetail {
    git_get_commit_detail(repo.to_str().unwrap(), hash).expect("commit detail")
}

fn file_diff(
    repo: &std::path::Path,
    hash: &str,
    path: &str,
    old_path: Option<&str>,
) -> GitCommitFileDiff {
    git_get_commit_file_diff(repo.to_str().unwrap(), hash, path, old_path).expect("file diff")
}

fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

// ---- pure helpers ----

#[test]
fn is_commit_hash_accepts_hex_prefixes_only() {
    assert!(is_commit_hash("abcd"));
    assert!(is_commit_hash(&"a".repeat(40)));
    assert!(
        is_commit_hash(&"a".repeat(64)),
        "SHA-256 ids are 64 characters"
    );
    assert!(is_commit_hash("E44B917"));
    assert!(!is_commit_hash("abc"));
    assert!(!is_commit_hash(&"a".repeat(65)));
    assert!(!is_commit_hash("--all"));
    assert!(!is_commit_hash("HEAD"));
    assert!(!is_commit_hash("a1b2 c3"));
}

#[test]
fn is_object_id_accepts_full_hex_ids_only() {
    assert!(is_object_id(&"a".repeat(40)));
    assert!(is_object_id(&"0".repeat(64)));
    assert!(!is_object_id(&"a".repeat(39)));
    assert!(!is_object_id(&"a".repeat(41)));
    assert!(!is_object_id(&"a".repeat(65)));
    assert!(!is_object_id(""));
}

#[test]
fn is_object_id_refuses_anything_that_could_read_as_an_option() {
    // A parent (or a blob's content) that starts with `-` must never reach argv.
    assert!(!is_object_id("--output=/tmp/pwned"));
    assert!(!is_object_id(&format!("-{}", "a".repeat(39))));
    assert!(!is_object_id(&format!("{}\n", "a".repeat(40))));
    assert!(!is_object_id(&format!("{} ", "a".repeat(39))));
}

#[test]
fn parse_show_header_keeps_the_message_body() {
    let out = "abc123\0dev@example.com\0p1 p2\0Subject line\n\nBody one\nBody two\n\n";
    let (hash, email, parents, message) = parse_show_header(out);
    assert_eq!(hash, "abc123");
    assert_eq!(email, "dev@example.com");
    assert_eq!(parents, vec!["p1".to_string(), "p2".to_string()]);
    assert_eq!(message, "Subject line\n\nBody one\nBody two");
}

#[test]
fn parse_show_header_root_commit_has_no_parents() {
    let (_, _, parents, message) = parse_show_header("abc\0e@x\0\0Init\n");
    assert!(parents.is_empty());
    assert_eq!(message, "Init");
}

#[test]
fn parse_name_status_z_reads_plain_and_rename_rows() {
    let out = "M\0src/a.rs\0R087\0old/b.rs\0new/b.rs\0D\0gone.txt\0";
    assert_eq!(
        parse_name_status_z(out),
        vec![
            (GitCommitFileStatus::Modified, None, "src/a.rs".to_string()),
            (
                GitCommitFileStatus::Renamed,
                Some("old/b.rs".to_string()),
                "new/b.rs".to_string()
            ),
            (GitCommitFileStatus::Deleted, None, "gone.txt".to_string()),
        ]
    );
}

#[test]
fn parse_name_status_z_reads_copy_and_type_change() {
    let out = "C100\0src.rs\0copy.rs\0T\0link\0A\0new.rs\0";
    let rows = parse_name_status_z(out);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].0, GitCommitFileStatus::Copied);
    assert_eq!(rows[0].1.as_deref(), Some("src.rs"));
    assert_eq!(rows[1].0, GitCommitFileStatus::TypeChanged);
    assert_eq!(rows[2].0, GitCommitFileStatus::Added);
}

#[test]
fn parse_name_status_z_skips_unknown_statuses_without_losing_sync() {
    // `U` (unmerged) and `X` (unknown) have no renderer letter: skip the row,
    // keep reading the rows after it.
    let out = "U\0conflict.txt\0M\0kept.txt\0X\0odd.txt\0A\0also-kept.txt\0";
    let rows = parse_name_status_z(out);
    let paths: Vec<&str> = rows.iter().map(|r| r.2.as_str()).collect();
    assert_eq!(paths, vec!["kept.txt", "also-kept.txt"]);
}

#[test]
fn file_status_serializes_as_the_single_letter() {
    use GitCommitFileStatus::*;
    for (status, letter) in [
        (Added, "A"),
        (Modified, "M"),
        (Deleted, "D"),
        (Renamed, "R"),
        (Copied, "C"),
        (TypeChanged, "T"),
    ] {
        let json = serde_json::to_value(status).expect("serialize");
        assert_eq!(json, serde_json::json!(letter));
        let back: GitCommitFileStatus = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, status);
    }
    assert!(serde_json::from_value::<GitCommitFileStatus>(serde_json::json!("U")).is_err());
}

#[test]
fn file_diff_serializes_too_large_in_camel_case() {
    let json = serde_json::to_value(GitCommitFileDiff {
        diff: String::new(),
        too_large: true,
    })
    .expect("serialize");
    assert_eq!(json, serde_json::json!({ "diff": "", "tooLarge": true }));
}

#[test]
fn parse_numstat_z_reads_counts_renames_and_binary() {
    let out = concat!(
        "3\t1\tsrc/a.rs\0",
        "2\t2\t\0old/b.rs\0new/b.rs\0",
        "-\t-\timg.png\0"
    );
    let stats = parse_numstat_z(out);
    assert_eq!(stats.get("src/a.rs"), Some(&(Some(3), Some(1))));
    assert_eq!(stats.get("new/b.rs"), Some(&(Some(2), Some(2))));
    assert_eq!(stats.get("img.png"), Some(&(None, None)));
    assert!(!stats.contains_key("old/b.rs"));
}

#[test]
fn merge_file_lists_keeps_order_and_caps() {
    let rows = vec![
        (GitCommitFileStatus::Modified, None, "a".to_string()),
        (GitCommitFileStatus::Added, None, "b".to_string()),
        (GitCommitFileStatus::Deleted, None, "c".to_string()),
    ];
    let mut stats = HashMap::new();
    stats.insert("a".to_string(), (Some(1), Some(2)));
    stats.insert("b".to_string(), (Some(5), Some(0)));
    let (files, truncated) = merge_file_lists(rows, stats, 2);
    assert!(truncated);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "a");
    assert_eq!(files[0].added, Some(1));
    assert_eq!(files[1].status, GitCommitFileStatus::Added);
    assert_eq!(files[1].removed, Some(0));
}

#[test]
fn invalid_hash_is_refused_before_git_runs() {
    let err = git_get_commit_detail("/definitely/not/a/repo", "--output=/tmp/x").unwrap_err();
    assert_eq!(err, CommitDetailError::InvalidHash);
    assert_eq!(err.code(), "INVALID_COMMIT_HASH");
}

// ---- real repositories ----

#[test]
fn it_root_commit_lists_added_files_against_the_empty_tree() {
    if git_missing() {
        return;
    }
    let repo = init_repo("root");
    write(&repo, "a.txt", b"one\ntwo\n");
    write(&repo, "src/b.rs", b"fn main() {}\n");
    let hash = commit(&repo, "Initial commit\n\nWith a body line.");

    let d = detail(&repo, &hash[..7]);
    assert_eq!(d.hash, hash);
    assert_eq!(d.author_email, "t@example.com");
    assert!(d.parents.is_empty());
    assert_eq!(d.message, "Initial commit\n\nWith a body line.");
    assert!(!d.files_truncated);
    let a = d.files.iter().find(|f| f.path == "a.txt").expect("a.txt");
    assert_eq!(
        (a.status, a.added, a.removed),
        (GitCommitFileStatus::Added, Some(2), Some(0))
    );
    assert!(d
        .files
        .iter()
        .any(|f| f.path == "src/b.rs" && f.status == GitCommitFileStatus::Added));
}

#[test]
fn it_detects_modify_delete_rename_and_binary() {
    if git_missing() {
        return;
    }
    let repo = init_repo("changes");
    write(&repo, "keep.txt", b"a\nb\nc\n");
    write(&repo, "drop.txt", b"x\n");
    write(
        &repo,
        "old/name.txt",
        b"line 1\nline 2\nline 3\nline 4\nline 5\n",
    );
    commit(&repo, "base");

    write(&repo, "keep.txt", b"a\nB\nc\nd\n");
    std::fs::remove_file(repo.join("drop.txt")).unwrap();
    std::fs::create_dir_all(repo.join("new")).unwrap();
    std::fs::rename(repo.join("old/name.txt"), repo.join("new/name.txt")).unwrap();
    write(&repo, "logo.bin", &[0u8, 159, 146, 150, 0, 1, 2]);
    let hash = commit(&repo, "change things");

    let d = detail(&repo, &hash);
    let by_path = |p: &str| d.files.iter().find(|f| f.path == p).cloned();
    let keep = by_path("keep.txt").expect("keep");
    assert_eq!(
        (keep.status, keep.added, keep.removed),
        (GitCommitFileStatus::Modified, Some(2), Some(1))
    );
    assert_eq!(
        by_path("drop.txt").expect("drop").status,
        GitCommitFileStatus::Deleted
    );
    let renamed = by_path("new/name.txt").expect("rename");
    assert_eq!(renamed.status, GitCommitFileStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("old/name.txt"));
    let bin = by_path("logo.bin").expect("binary");
    assert_eq!((bin.added, bin.removed), (None, None));
}

#[test]
fn it_merge_commit_diffs_against_the_first_parent() {
    if git_missing() {
        return;
    }
    let repo = init_repo("merge");
    write(&repo, "base.txt", b"base\n");
    commit(&repo, "base");
    git(&repo, &["checkout", "-q", "-b", "feature"]);
    write(&repo, "feature.txt", b"f1\nf2\n");
    commit(&repo, "feature work");
    git(&repo, &["checkout", "-q", "main"]);
    write(&repo, "main.txt", b"m\n");
    commit(&repo, "main work");
    git(
        &repo,
        &["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"],
    );
    let merge = git(&repo, &["rev-parse", "HEAD"]);

    let d = detail(&repo, &merge);
    assert_eq!(d.parents.len(), 2);
    assert_eq!(d.message, "Merge feature");
    let paths: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["feature.txt"]);
}

#[test]
fn it_unknown_commit_is_a_git_failure_with_a_stable_code() {
    if git_missing() {
        return;
    }
    let repo = init_repo("unknown");
    write(&repo, "a.txt", b"a\n");
    commit(&repo, "base");
    let err = git_get_commit_detail(repo.to_str().unwrap(), &"f".repeat(40)).unwrap_err();
    assert!(matches!(
        err,
        CommitDetailError::Git(GitRunError::GitFailed {
            command: "rev-parse",
            ..
        })
    ));
    assert_eq!(err.code(), "GIT_COMMIT_DETAIL_ERROR");
}

#[test]
fn commit_file_diff_refuses_bad_hash_and_unsafe_paths() {
    let cwd = "/definitely/not/a/repo";
    assert_eq!(
        git_get_commit_file_diff(cwd, "HEAD", "a.txt", None).unwrap_err(),
        CommitDetailError::InvalidHash
    );
    for bad in ["../x", "/etc/passwd", "", "a/../../b"] {
        let err = git_get_commit_file_diff(cwd, "abcd", bad, None).unwrap_err();
        assert_eq!(err, CommitDetailError::InvalidPath, "{bad}");
        assert_eq!(err.code(), "INVALID_PATH");
    }
    let err = git_get_commit_file_diff(cwd, "abcd", "ok.txt", Some("../old")).unwrap_err();
    assert_eq!(err, CommitDetailError::InvalidPath);
}

#[test]
fn it_commit_file_diff_shows_the_change_against_the_first_parent() {
    if git_missing() {
        return;
    }
    let repo = init_repo("filediff");
    write(&repo, "a.txt", b"one\ntwo\n");
    write(&repo, "other.txt", b"x\n");
    commit(&repo, "base");
    write(&repo, "a.txt", b"one\nTWO\nthree\n");
    write(&repo, "other.txt", b"y\n");
    let hash = commit(&repo, "edit");

    let diff = file_diff(&repo, &hash, "a.txt", None);
    assert!(!diff.too_large);
    let diff = diff.diff;
    assert!(diff.contains("--- a/a.txt"), "{diff}");
    assert!(diff.contains("-two"));
    assert!(diff.contains("+TWO"));
    assert!(diff.contains("+three"));
    assert!(!diff.contains("other.txt"), "only the requested file");
}

#[test]
fn it_commit_file_diff_of_a_root_commit_adds_the_file() {
    if git_missing() {
        return;
    }
    let repo = init_repo("filediff-root");
    write(&repo, "new.txt", b"hello\n");
    let hash = commit(&repo, "root");
    let diff = file_diff(&repo, &hash, "new.txt", None).diff;
    assert!(diff.contains("new file mode"), "{diff}");
    assert!(diff.contains("+hello"));
}

#[test]
fn it_commit_file_diff_pairs_a_rename_with_its_old_path() {
    if git_missing() {
        return;
    }
    let repo = init_repo("filediff-rename");
    write(&repo, "old.txt", b"l1\nl2\nl3\nl4\nl5\nl6\n");
    commit(&repo, "base");
    std::fs::rename(repo.join("old.txt"), repo.join("new.txt")).unwrap();
    let hash = commit(&repo, "rename");
    let diff = file_diff(&repo, &hash, "new.txt", Some("old.txt")).diff;
    assert!(diff.contains("rename from old.txt"), "{diff}");
    assert!(diff.contains("rename to new.txt"));
}

// ---- argument injection: the hash must resolve to a commit ----

/// Write a blob whose content is a git option that would create `target`, and
/// return the blob's hash. The first fix for this bug let the blob content
/// reach `git diff` as a revision, and git wrote the file.
fn option_blob(repo: &std::path::Path, target: &std::path::Path) -> String {
    write(
        repo,
        "payload.tmp",
        format!("--output={}", target.display()).as_bytes(),
    );
    let id = git(repo, &["hash-object", "-w", "payload.tmp"]);
    std::fs::remove_file(repo.join("payload.tmp")).unwrap();
    id
}

#[test]
fn it_blob_hash_is_refused_and_its_content_never_reaches_git() {
    if git_missing() {
        return;
    }
    let repo = init_repo("inject-blob");
    write(&repo, "a.txt", b"one\n");
    commit(&repo, "base");
    let out = unique_temp_dir("inject-blob-out");
    let target = out.join("pwned");
    let blob = option_blob(&repo, &target);

    let err = git_get_commit_detail(repo.to_str().unwrap(), &blob).unwrap_err();
    assert!(
        matches!(
            err,
            CommitDetailError::Git(GitRunError::GitFailed {
                command: "rev-parse",
                ..
            })
        ),
        "{err:?}"
    );
    assert!(!target.exists(), "detail must not run the blob content");

    let err = git_get_commit_file_diff(repo.to_str().unwrap(), &blob, "a.txt", None).unwrap_err();
    assert_eq!(err.code(), "GIT_COMMIT_DETAIL_ERROR");
    assert!(!target.exists(), "file diff must not run the blob content");
}

#[test]
fn it_blob_hash_abbreviation_is_refused_too() {
    if git_missing() {
        return;
    }
    let repo = init_repo("inject-blob-short");
    write(&repo, "a.txt", b"one\n");
    commit(&repo, "base");
    let out = unique_temp_dir("inject-blob-short-out");
    let target = out.join("pwned");
    let blob = option_blob(&repo, &target);
    assert!(git_get_commit_detail(repo.to_str().unwrap(), &blob[..10]).is_err());
    assert!(!target.exists());
}

#[test]
fn it_tree_hash_is_refused() {
    if git_missing() {
        return;
    }
    let repo = init_repo("inject-tree");
    write(&repo, "a.txt", b"one\n");
    commit(&repo, "base");
    let tree = git(&repo, &["rev-parse", "HEAD^{tree}"]);
    let err = git_get_commit_detail(repo.to_str().unwrap(), &tree).unwrap_err();
    assert!(matches!(err, CommitDetailError::Git(_)), "{err:?}");
    assert!(git_get_commit_file_diff(repo.to_str().unwrap(), &tree, "a.txt", None).is_err());
}

/// A signed commit with `log.showSignature` prints GPG text before `%H`.
/// The detail read must ignore that config.
#[cfg(unix)]
#[test]
fn it_signed_commit_detail_ignores_show_signature() {
    use std::os::unix::fs::PermissionsExt;
    if git_missing()
        || std::process::Command::new("gpg")
            .arg("--version")
            .output()
            .is_err()
    {
        return;
    }
    let home = unique_temp_dir("gpg-home");
    std::fs::set_permissions(&*home, std::fs::Permissions::from_mode(0o700))
        .expect("gpg home mode");
    let home_s = home.to_str().unwrap();
    let gen = std::process::Command::new("gpg")
        .env("GNUPGHOME", home_s)
        .args([
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "",
            "--quick-gen-key",
            "Termul Test <t@example.com>",
            "ed25519",
            "sign",
            "never",
        ])
        .output()
        .expect("run gpg");
    assert!(
        gen.status.success(),
        "gpg keygen failed: {}",
        String::from_utf8_lossy(&gen.stderr)
    );
    let listed = std::process::Command::new("gpg")
        .env("GNUPGHOME", home_s)
        .args(["--batch", "--list-secret-keys", "--with-colons"])
        .output()
        .expect("list gpg keys");
    let fpr = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .find_map(|line| {
            let mut cols = line.split(':');
            (cols.next()? == "fpr")
                .then(|| cols.nth(8).unwrap_or("").to_string())
                .filter(|s| !s.is_empty())
        })
        .expect("signing fingerprint");

    let repo = init_repo("show-sig");
    git(&repo, &["config", "gpg.format", "openpgp"]);
    git(&repo, &["config", "gpg.program", "gpg"]);
    git(&repo, &["config", "user.signingkey", &fpr]);
    git(&repo, &["config", "log.showSignature", "true"]);
    write(&repo, "a.txt", b"one\n");
    git(&repo, &["add", "-A"]);
    let signed = std::process::Command::new("git")
        .current_dir(&*repo)
        .env("GNUPGHOME", home_s)
        .args(["commit", "-q", "-S", "-m", "signed init"])
        .output()
        .expect("signed commit");
    assert!(
        signed.status.success(),
        "signed commit failed: {}",
        String::from_utf8_lossy(&signed.stderr)
    );
    let hash = git(&repo, &["rev-parse", "HEAD"]);

    let d = detail(&repo, &hash);
    assert_eq!(d.hash, hash);
    assert_eq!(d.message, "signed init");
    assert_eq!(d.author_email, "t@example.com");
    let diff = file_diff(&repo, &hash, "a.txt", None);
    assert!(!diff.too_large);
    assert!(diff.diff.contains("+one"), "{}", diff.diff);
}

#[test]
fn it_annotated_tag_resolves_to_its_commit() {
    if git_missing() {
        return;
    }
    let repo = init_repo("tag");
    write(&repo, "a.txt", b"one\n");
    let hash = commit(&repo, "base");
    git(&repo, &["tag", "-a", "v1", "-m", "release"]);
    let tag_object = git(&repo, &["rev-parse", "v1"]);
    assert_ne!(tag_object, hash);
    assert_eq!(detail(&repo, &tag_object).hash, hash);
}

// ---- output past the pipe buffer, the file cap, and the file-list cap ----

#[test]
fn it_file_diff_larger_than_the_pipe_buffer_is_returned_whole() {
    if git_missing() {
        return;
    }
    let repo = init_repo("diff-big");
    write(&repo, "big.txt", b"seed\n");
    commit(&repo, "base");
    // ~400 KB of changed lines: past the ~64 KB pipe buffer, under the cap.
    let body: String = (0..40_000).map(|i| format!("line {i:05}\n")).collect();
    write(&repo, "big.txt", body.as_bytes());
    let hash = commit(&repo, "grow");

    let result = file_diff(&repo, &hash, "big.txt", None);
    assert!(!result.too_large);
    assert!(result.diff.len() > 64 * 1024);
    assert!(result.diff.contains("+line 39999"));
}

#[test]
fn it_file_diff_over_the_cap_is_reported_as_too_large() {
    if git_missing() {
        return;
    }
    let repo = init_repo("diff-too-large");
    // 3 MiB of added lines: over MAX_FILE_DIFF_BYTES.
    let body: String = (0..230_000).map(|i| format!("line {i:07}\n")).collect();
    assert!(body.len() > MAX_FILE_DIFF_BYTES);
    write(&repo, "huge.txt", body.as_bytes());
    let hash = commit(&repo, "huge");

    let result = file_diff(&repo, &hash, "huge.txt", None);
    assert_eq!(
        result,
        GitCommitFileDiff {
            diff: String::new(),
            too_large: true
        }
    );
}

#[test]
fn it_file_diff_at_the_cap_is_still_returned() {
    if git_missing() {
        return;
    }
    let repo = init_repo("diff-small");
    write(&repo, "s.txt", b"x\n");
    let hash = commit(&repo, "small");
    let result = file_diff(&repo, &hash, "s.txt", None);
    assert!(!result.too_large);
    assert!(result.diff.len() < MAX_FILE_DIFF_BYTES);
}

#[test]
fn it_commit_with_more_than_the_file_cap_is_truncated() {
    if git_missing() {
        return;
    }
    let repo = init_repo("many-files");
    let total = MAX_COMMIT_FILES + 50;
    // Long paths push each diff-tree run past the ~64 KB pipe buffer too.
    let pad = "p".repeat(60);
    for i in 0..total {
        write(
            &repo,
            &format!("dir/{pad}-{i:05}.txt"),
            format!("{i}\n").as_bytes(),
        );
    }
    let hash = commit(&repo, "many files");

    let d = detail(&repo, &hash);
    assert!(d.files_truncated);
    assert_eq!(d.files.len(), MAX_COMMIT_FILES);
    assert!(d.files.iter().all(|f| f.added == Some(1)));
}

#[test]
fn it_sha256_repository_root_commit_and_file_diff_work() {
    if git_missing() {
        return;
    }
    let repo = unique_temp_dir("sha256");
    let init = GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["init", "-q", "--object-format=sha256"],
    );
    if !init.is_some_and(|o| o.status.success()) {
        return; // git too old for SHA-256 repositories
    }
    git(&repo, &["config", "user.email", "t@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    write(&repo, "a.txt", b"one\n");
    let hash = commit(&repo, "root");
    assert_eq!(hash.len(), 64);

    let d = detail(&repo, &hash[..12]);
    assert_eq!(d.hash, hash);
    assert_eq!(d.files.len(), 1);
    assert!(file_diff(&repo, &hash, "a.txt", None).diff.contains("+one"));
}
