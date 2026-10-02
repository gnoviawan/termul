use super::*;

pub fn git_get_status_detail(cwd: &str) -> Result<Vec<GitStatusDetail>, String> {
    let output = GitTracker::run_git_command(cwd, &["status", "--porcelain"])
        .ok_or_else(|| "Failed to run git status".to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(git_get_status_detail_from_output(&stdout))
}

pub(super) fn git_get_status_detail_from_output(output: &str) -> Vec<GitStatusDetail> {
    let mut details = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }

        let index_status = line.chars().next().unwrap_or(' ');
        let work_tree_status = line.chars().nth(1).unwrap_or(' ');
        let raw_path = &line[3..];
        let path = if index_status == 'R' || work_tree_status == 'R' {
            raw_path
                .rsplit_once(" -> ")
                .map(|(_, new_path)| new_path)
                .unwrap_or(raw_path)
                .to_string()
        } else {
            raw_path.to_string()
        };

        if index_status != ' ' && index_status != '?' {
            details.push(GitStatusDetail {
                path: path.clone(),
                status: match index_status {
                    'A' => "added",
                    'M' => "modified",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string(),
                staged: true,
            });
        }

        if work_tree_status != ' ' {
            details.push(GitStatusDetail {
                path: path.clone(),
                status: match work_tree_status {
                    'M' => "modified",
                    'D' => "deleted",
                    '?' => "untracked",
                    _ => "modified",
                }
                .to_string(),
                staged: false,
            });
        }
    }

    details
}

/// Git treats `/dev/null` as a magic empty-file token on all platforms,
/// including Git for Windows, so it is safe to use for `diff --no-index`.
pub(super) const NULL_DEVICE: &str = "/dev/null";

/// Select the `git diff` argument vector for a single path.
///
/// - Untracked files have nothing in the index, so they are shown in full as
///   additions via `--no-index`.
/// - Staged rows compare the index against HEAD (`--cached`).
/// - Unstaged rows compare the working tree against the index.
pub(super) fn build_diff_args(path: &str, is_untracked: bool, staged: bool) -> Vec<&str> {
    if is_untracked {
        vec!["diff", "--no-index", "--", NULL_DEVICE, path]
    } else if staged {
        vec!["diff", "--cached", "--", path]
    } else {
        vec!["diff", "--", path]
    }
}

pub fn git_get_diff(cwd: &str, path: &str, staged: bool) -> Result<String, String> {
    if is_git_ignored(cwd, path)? {
        return Ok(String::new());
    }

    // First check if file is untracked (but not ignored)
    let status_output = GitTracker::run_git_command(cwd, &["status", "--porcelain", "--", path])
        .ok_or_else(|| "Failed to run git status".to_string())?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let is_untracked = status_str.starts_with("??");

    let args = build_diff_args(path, is_untracked, staged);

    let output = GitTracker::run_git_command(cwd, &args)
        .ok_or_else(|| "Failed to run git diff".to_string())?;

    // git diff returns 1 if there are differences, which is "success" for us
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if stdout.is_empty() && is_untracked {
        // Fallback for untracked files if diff --no-index fails or returns empty
        return std::fs::read_to_string(std::path::Path::new(cwd).join(path))
            .map_err(|e| e.to_string());
    }

    Ok(stdout)
}

/// What discarding a path should do, derived from its `git status --porcelain` line.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DiscardAction {
    /// Untracked entry: delete it from disk.
    DeleteUntracked,
    /// Tracked change: revert the working tree to the index (`git checkout -- <path>`).
    /// This never touches the index, so staged content is preserved.
    RevertWorktree,
    /// Nothing to discard (clean or unknown path).
    Noop,
}

/// Classify the discard action from a `git status --porcelain` line.
/// The first column is the index (staged) status; `??` marks untracked entries.
pub(super) fn classify_discard_action(status_line: &str) -> DiscardAction {
    if status_line.trim().is_empty() {
        return DiscardAction::Noop;
    }
    if status_line.starts_with('?') {
        return DiscardAction::DeleteUntracked;
    }
    DiscardAction::RevertWorktree
}

/// Whether `path` is a safe repo-relative path: non-empty, no absolute root,
/// drive prefix, `..` traversal, or `.`/`./` component. Used to gate raw
/// filesystem deletes against escaping `cwd` — AND against resolving to `cwd`
/// itself: `Path::join(".") == cwd`, so a whole-repo pathspec like `.`, `./`,
/// `dir/..`, or `dir/.` would make `delete_untracked_path` `remove_dir_all`
/// the entire working tree including `.git` (F-006). The discard contract is
/// a single-file op, so any no-op path component is refused. A TRAILING `/.`
/// is checked separately because `components()` drops it.
pub(super) fn is_safe_relative_path(path: &str) -> bool {
    use std::path::Component;
    if path.is_empty() {
        return false;
    }
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return false;
    }
    // `components()` elides a trailing `.` (`dir/.` yields just `dir`), which
    // would still resolve to the directory itself when joined to `cwd`.
    if path.ends_with("/.") || path.ends_with("\\.") {
        return false;
    }
    !p.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::CurDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn git_command_result(cwd: &str, args: &[&str], failure_context: &str) -> Result<(), String> {
    let output = GitTracker::run_git_command(cwd, args)
        .ok_or_else(|| format!("Failed to run {failure_context}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn git_command_result_with_long_timeout(
    cwd: &str,
    args: &[&str],
    failure_context: &str,
) -> Result<(), String> {
    let output = GitTracker::run_git_command_with_timeout(cwd, args, GIT_NETWORK_TIMEOUT_MS)
        .ok_or_else(|| format!("Failed to run {failure_context}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Whether the repository has a resolvable HEAD (i.e. at least one commit).
pub(super) fn repo_has_head(cwd: &str) -> bool {
    GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check out an existing branch. Remote branches use `--track`.
pub fn git_checkout_branch(cwd: &str, branch: &str, is_remote: bool) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("Branch name is required".to_string());
    }

    if is_remote {
        git_command_result_with_long_timeout(
            cwd,
            &["checkout", "-q", "--track", branch],
            "git checkout --track",
        )
    } else {
        git_command_result_with_long_timeout(cwd, &["checkout", "-q", branch], "git checkout")
    }
}

/// Create a new branch from `start_ref` (defaults to HEAD) and check it out.
pub fn git_create_branch(cwd: &str, branch: &str, start_ref: Option<&str>) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is required".to_string());
    }

    let start = start_ref
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    git_command_result_with_long_timeout(
        cwd,
        &["checkout", "-q", "-b", branch, start],
        "git checkout -b",
    )
}

/// Stage a single file (`git add -- <path>`). Works for modified and untracked files.
pub fn git_stage_file(cwd: &str, path: &str) -> Result<(), String> {
    git_command_result(cwd, &["add", "--", path], "git add")
}

/// Unstage a single file.
///
/// When the repo has a HEAD, `git reset -q HEAD -- <path>` restores the index
/// entry to its committed version. `git reset` only touches the index (never
/// the working tree) and works on all Git versions, unlike `git restore`
/// (Git >= 2.23). With no commits yet there is no HEAD to reset to, so the
/// entry is removed from the index while the working-tree file is kept intact.
pub fn git_unstage_file(cwd: &str, path: &str) -> Result<(), String> {
    if repo_has_head(cwd) {
        git_command_result(cwd, &["reset", "-q", "HEAD", "--", path], "git reset")
    } else {
        git_command_result(cwd, &["rm", "--cached", "--", path], "git rm --cached")
    }
}

/// Validate that a single-hunk unified-diff fragment references only the
/// expected safe relative `path` in its `--- ` / `+++ ` headers.
///
/// `git apply` defaults to `-p1`, which strips the first path component of
/// whatever the patch header declares. A header like `+++ c/../../etc/passwd`
/// therefore resolves to `../../etc/passwd` after the strip. The previous
/// implementation only inspected headers that began with `--- a/` or
/// `+++ b/`, so any other prefix bypassed the guard entirely. This is the
/// security boundary for a renderer-supplied patch, so it positively
/// requires both headers to be present and validates the `-p1`-stripped
/// result against `expected_path`.
///
/// To avoid misreading a hunk *body* line as a structural header (e.g. a
/// deletion of `-- comment` produces the diff line `--- comment`), the
/// scan walks the body using the `@@` declared counts and only treats a
/// `--- `/`+++ ` line as a header when it lies outside a hunk body. This
/// also keeps the multi-file-injection defense intact: a `--- `/`+++ `
/// line that appears after a hunk's body has been consumed is still
/// treated as a structural header and rejected if it targets another path.
pub(super) fn validate_hunk_patch_paths(expected_path: &str, patch: &str) -> Result<(), String> {
    if !is_safe_relative_path(expected_path) {
        return Err(format!(
            "Refusing hunk patch for unsafe path: {expected_path}"
        ));
    }
    let mut found_from = false;
    let mut found_to = false;
    // Hunk body budget from the most recent `@@`. `hunk_active` is true
    // while we are inside a hunk; `old_left`/`new_left` track how many
    // body lines the declared counts still allow.
    let mut hunk_active = false;
    let mut old_left: usize = 0;
    let mut new_left: usize = 0;

    for line in patch.lines() {
        let in_body = hunk_active && (old_left > 0 || new_left > 0 || line.starts_with('\\'));
        if in_body {
            match line.chars().next() {
                Some(' ') => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
                Some('-') => old_left = old_left.saturating_sub(1),
                Some('+') => new_left = new_left.saturating_sub(1),
                Some('\\') => {}
                _ => hunk_active = false, // malformed body line; back to structural
            }
            if hunk_active {
                continue;
            }
        } else if hunk_active && !line.starts_with('\\') {
            // Budget exhausted and the line is not trailing meta → the hunk
            // has ended; re-enter structural scanning.
            hunk_active = false;
        }

        if line.starts_with("@@") {
            if let Some((o, n)) = parse_hunk_budget(line) {
                old_left = o;
                new_left = n;
                hunk_active = true;
            }
            continue;
        }
        let is_from = line.starts_with("--- ");
        let is_to = line.starts_with("+++ ");
        if !(is_from || is_to) {
            continue;
        }
        if is_from {
            found_from = true;
        } else {
            found_to = true;
        }
        // Header format: `--- <path>[<tab><timestamp>]`. Take the first
        // whitespace-delimited token as the path, then strip one leading
        // component to mirror `git apply -p1`.
        let raw = &line[4..];
        let path_token = raw.split_whitespace().next().unwrap_or(raw);
        let stripped = strip_first_path_component(path_token);
        if stripped != expected_path {
            return Err(format!(
                "Hunk patch path '{stripped}' does not match expected '{expected_path}'"
            ));
        }
    }
    if !(found_from && found_to) {
        return Err("Hunk patch is missing its --- or +++ header".to_string());
    }
    Ok(())
}

/// Parse `@@ -oldStart[,oldCount] +newStart[,newCount] @@` into the number
/// of old/new body lines the hunk declares. Omitted counts default to 1
/// (unified-diff spec).
fn parse_hunk_budget(header: &str) -> Option<(usize, usize)> {
    let after = header.strip_prefix("@@ ")?;
    let core = after.split("@@").next()?.trim();
    let mut parts = core.split_whitespace();
    let old_part = parts.next()?;
    let new_part = parts.next()?;
    let count_of = |p: &str| -> Option<usize> {
        let after_sign = p.strip_prefix('-').or_else(|| p.strip_prefix('+'))?;
        let count = after_sign.split_once(',').map(|(_, c)| c).unwrap_or("1");
        count.parse::<usize>().ok()
    };
    Some((count_of(old_part)?, count_of(new_part)?))
}

/// Strip the first path component, mirroring `git apply -p1`.
/// `a/foo.txt` -> `foo.txt`; `foo.txt` (no separator) is returned as-is.
fn strip_first_path_component(s: &str) -> &str {
    match s.find('/') {
        Some(idx) => &s[idx + 1..],
        None => s,
    }
}

/// Run `git apply` with a patch supplied on stdin. Used for per-hunk
/// stage/unstage where the patch is a single-hunk fragment built by the
/// renderer from the displayed diff. Follows the same deadline pattern as
/// `GitTracker::spawn_and_wait` so a wedged `git apply` cannot hang the
/// caller.
fn run_git_apply(cwd: &str, args: &[&str], patch: &str) -> Result<(), String> {
    use std::io::Write;

    let git = resolve_git_binary();
    let mut command = backend_command(git);
    command.current_dir(cwd).args(args.iter());
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn git apply: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        // Ignore broken pipe: git may finish reading the patch and exit
        // before we finish writing (e.g. it rejects the patch early). The
        // exit status below is the source of truth.
        let _ = stdin.write_all(patch.as_bytes());
    }

    let deadline = Instant::now() + Duration::from_millis(GIT_COMMAND_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("git apply wait failed: {e}"))?;
                if output.status.success() {
                    return Ok(());
                }
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git apply timed out after {GIT_COMMAND_TIMEOUT_MS}ms"
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("git apply wait error: {e}")),
        }
    }
}

/// Stage a single hunk. The renderer builds the hunk patch from the
/// working-tree diff; applying it to the index (`git apply --cached`)
/// stages exactly those lines without staging the rest of the file.
/// `--recount` tolerates a line-count mismatch in the `@@` header, which
/// the renderer's patch builder can produce when it strips surrounding
/// context.
pub fn git_stage_hunk(cwd: &str, path: &str, hunk_patch: &str) -> Result<(), String> {
    validate_hunk_patch_paths(path, hunk_patch)?;
    run_git_apply(cwd, &["apply", "--cached", "--recount", "-"], hunk_patch)
}

/// Unstage a single hunk. The renderer builds the hunk patch from the
/// staged (index vs HEAD) diff; reverse-applying it to the index removes
/// exactly those lines from the index without touching the working tree.
pub fn git_unstage_hunk(cwd: &str, path: &str, hunk_patch: &str) -> Result<(), String> {
    validate_hunk_patch_paths(path, hunk_patch)?;
    run_git_apply(
        cwd,
        &["apply", "--cached", "--recount", "--reverse", "-"],
        hunk_patch,
    )
}

/// Delete an untracked file or directory from disk. Treats an already-missing
/// path as success (a concurrent delete still satisfies the intent).
fn delete_untracked_path(cwd: &str, path: &str) -> Result<(), String> {
    if !is_safe_relative_path(path) {
        return Err(format!("Refusing to delete unsafe path: {path}"));
    }
    let target = std::path::Path::new(cwd).join(path);
    let result = if target.is_dir() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Discard changes to a single file. Untracked entries are deleted from disk;
/// tracked changes revert the working tree to the index (`git checkout -- <path>`),
/// which preserves any staged content. A clean/unknown path is a no-op.
pub fn git_discard_file(cwd: &str, path: &str) -> Result<(), String> {
    let status_output = GitTracker::run_git_command(cwd, &["status", "--porcelain", "--", path])
        .ok_or_else(|| "Failed to run git status".to_string())?;
    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let status_line = status_str.lines().next().unwrap_or("");

    match classify_discard_action(status_line) {
        DiscardAction::DeleteUntracked => delete_untracked_path(cwd, path),
        DiscardAction::RevertWorktree => {
            git_command_result(cwd, &["checkout", "--", path], "git checkout")
        }
        DiscardAction::Noop => Ok(()),
    }
}

/// Default number of commits to read for the history view.
const GIT_LOG_DEFAULT_LIMIT: u32 = 200;
/// Upper bound on the history fetch to keep render/parse cost bounded.
const GIT_LOG_MAX_LIMIT: u32 = 1000;

/// Field separator inside one `git log` record (NUL, `%x00`).
const LOG_FIELD_SEP: char = '\u{0}';
/// Record terminator between `git log` entries (`%x1e`, record separator).
const LOG_RECORD_SEP: char = '\u{1e}';

/// Read commit history for `cwd` as structured [`GitCommit`] rows, newest first.
///
/// Uses a NUL-delimited `--pretty` format with a record terminator so commit
/// subjects containing spaces, pipes, or other punctuation cannot break parsing.
/// `--parents` yields parent SHAs (for graph topology), `--decorate=full`
/// yields ref names, and `--topo-order` emits commits child-before-parent so the
/// renderer's lane layout never sees a parent before its child.
///
/// A *benign* failure (a repo with no commits yet, or a path that is not a git
/// repository) is reported as an empty history so the UI shows an empty state.
/// Any other non-zero exit (corrupt `.git`, unreadable objects, permission
/// errors) is propagated as an error so real failures are surfaced.
pub fn git_get_log(cwd: &str, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let limit = limit
        .unwrap_or(GIT_LOG_DEFAULT_LIMIT)
        .clamp(1, GIT_LOG_MAX_LIMIT);
    let limit_str = limit.to_string();

    let args = [
        "log",
        "--no-color",
        "--topo-order",
        "-n",
        &limit_str,
        "--parents",
        "--decorate=full",
        "--pretty=format:%H%x00%h%x00%P%x00%D%x00%an%x00%aI%x00%s%x1e",
    ];

    let output = GitTracker::run_git_command(cwd, &args)
        .ok_or_else(|| "Failed to run git log".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A repo with no commits yet, or a non-repo path, is an expected empty
        // state — not an error. Everything else (corrupt objects, permission
        // problems) is surfaced so it is not silently swallowed.
        if is_benign_log_failure(&stderr) {
            return Ok(Vec::new());
        }
        return Err(stderr.trim().to_string());
    }

    Ok(parse_git_log(&String::from_utf8_lossy(&output.stdout)))
}

/// Whether a failing `git log` stderr represents an expected empty-history
/// state (no commits yet, or not a git repository) rather than a real error.
pub(super) fn is_benign_log_failure(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("does not have any commits yet")
        || s.contains("not a git repository")
        || s.contains("bad default revision")
        // Fresh repo with an unborn HEAD: `ambiguous argument 'HEAD'`.
        || (s.contains("ambiguous argument") && s.contains("head"))
}

/// Parse the NUL-delimited, record-terminated `git log` output produced by
/// [`git_get_log`] into [`GitCommit`] rows. Pure function over captured stdout
/// so it is unit-testable without spawning git.
pub(super) fn parse_git_log(stdout: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();

    for record in stdout.split(LOG_RECORD_SEP) {
        // Trim only leading newlines git inserts between records; the fields
        // themselves are NUL-separated so internal whitespace is preserved.
        let record = record.trim_start_matches(['\n', '\r']);
        if record.is_empty() {
            continue;
        }

        let fields: Vec<&str> = record.split(LOG_FIELD_SEP).collect();
        // hash, shortHash, parents, refs, author, date, subject
        if fields.len() < 7 {
            continue;
        }

        let hash = fields[0].trim();
        if hash.is_empty() {
            continue;
        }

        let parents = fields[2]
            .split_whitespace()
            .map(str::to_string)
            .collect::<Vec<_>>();

        // `%D` separates decorations with ", " (comma-space). Split on that exact
        // separator rather than a bare comma so a ref name containing a comma is
        // not torn into two chips.
        let refs = fields[3]
            .split(", ")
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();

        commits.push(GitCommit {
            hash: hash.to_string(),
            short_hash: fields[1].trim().to_string(),
            parents,
            refs,
            author: fields[4].to_string(),
            date: fields[5].trim().to_string(),
            // Subject is the final field and may legitimately be empty. Re-join
            // any trailing fields with the NUL separator so a stray NUL in an
            // earlier field cannot silently truncate the subject.
            subject: fields[6..].join("\u{0}"),
        });
    }

    commits
}

/// Network-bound git operations (push/fetch) get a generous timeout instead of
/// the 2s status-poll default. 120s comfortably covers most pushes.
const GIT_NETWORK_TIMEOUT_MS: u64 = 120_000;

/// Build the commit message body from a summary and optional description.
/// Format: `summary`, a blank line, then the trimmed description. The blank
/// line and body are omitted when the description is empty.
pub(super) fn build_commit_message(summary: &str, description: &str) -> String {
    let summary = summary.trim();
    let description = description.trim();
    if description.is_empty() {
        summary.to_string()
    } else {
        format!("{summary}\n\n{description}")
    }
}

/// Number of staged entries via `git diff --cached --name-only`.
/// Returns `None` when the git invocation itself fails, so callers can
/// distinguish "genuinely nothing staged" (`Some(0)`) from "could not tell".
pub(super) fn staged_entry_count(cwd: &str) -> Option<u32> {
    GitTracker::run_git_command(cwd, &["diff", "--cached", "--name-only"])
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
}

/// Create a commit from the currently-staged index.
///
/// The message is written to a temp file and passed via `git commit -F <file>`
/// so arbitrary user text is never interpolated into a shell or `-m` argument;
/// this also preserves multi-line bodies. The temp file is created with an
/// exclusive, uniquely-named handle (no symlink-following clobber, no collision
/// between near-simultaneous commits) and deleted after the commit attempt.
///
/// `amend` rewrites HEAD instead of creating a new commit. A plain commit with
/// nothing staged is rejected; an amend requires an existing HEAD. Uses the
/// network-length timeout so pre-commit hooks / GPG passphrase prompts are not
/// killed mid-run (which could leave a stale `.git/index.lock`).
pub fn git_commit_file(
    cwd: &str,
    summary: &str,
    description: &str,
    amend: bool,
) -> Result<(), String> {
    if summary.trim().is_empty() {
        return Err("Commit summary cannot be empty".to_string());
    }
    if amend {
        if !repo_has_head(cwd) {
            return Err("No commit to amend".to_string());
        }
    } else {
        match staged_entry_count(cwd) {
            Some(0) => return Err("Nothing staged to commit".to_string()),
            None => return Err("Failed to read the staged index".to_string()),
            Some(_) => {}
        }
    }

    let message = build_commit_message(summary, description);
    let msg_path = create_commit_message_file(message.as_bytes())?;

    // Pass the real OS path (not a lossy String) so a non-UTF-8 temp dir still
    // resolves to the file we actually wrote.
    use std::ffi::OsStr;
    let mut args: Vec<&OsStr> = vec![OsStr::new("commit"), OsStr::new("-F"), msg_path.as_os_str()];
    if amend {
        args.push(OsStr::new("--amend"));
    }

    let result = match GitTracker::run_git_command_with_timeout(cwd, &args, GIT_NETWORK_TIMEOUT_MS)
    {
        Some(output) if output.status.success() => Ok(()),
        Some(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        None => Err("git commit timed out or failed to start".to_string()),
    };
    // Always clean up the temp message file, regardless of commit outcome.
    let _ = std::fs::remove_file(&msg_path);
    result
}

/// Write `bytes` to a freshly-created, uniquely-named temp file using an
/// exclusive create (`create_new`), which fails rather than following a symlink
/// or truncating an existing file (CWE-59/CWE-377). Returns the path on success.
fn create_commit_message_file(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let pid = std::process::id();
    for attempt in 0..8u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path =
            std::env::temp_dir().join(format!("termul-commitmsg-{pid}-{nanos}-{attempt}.txt"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // O_EXCL: fail if the path already exists
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(bytes).and_then(|_| f.flush()).map_err(|e| {
                    let _ = std::fs::remove_file(&path);
                    format!("Failed to write commit message: {e}")
                })?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create commit message file: {e}")),
        }
    }
    Err("Failed to create a unique commit message file".to_string())
}

/// Push the current branch to `origin`. When the branch has no upstream, it is
/// published with `--set-upstream origin <branch>`. Uses the network timeout.
/// Rejects in a detached-HEAD / no-branch state.
pub fn git_push_current(cwd: &str) -> Result<(), String> {
    let branch = GitTracker::check_branch_internal(cwd)
        .ok_or_else(|| "Not on a branch (detached HEAD); cannot push".to_string())?;

    let has_upstream =
        GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "@{u}"])
            .map(|o| o.status.success())
            .unwrap_or(false);

    let args: Vec<&str> = if has_upstream {
        vec!["push"]
    } else {
        vec!["push", "--set-upstream", "origin", &branch]
    };

    let output = GitTracker::run_git_push(cwd, &args, GIT_NETWORK_TIMEOUT_MS).ok_or_else(|| {
        "git push did not complete (it timed out, could not start, or the \
             remote required interactive credentials)"
            .to_string()
    })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Gather the commit-footer context for a repo. Tolerant of no-HEAD and
/// no-upstream repos: missing values come back as zeros / empty / false.
pub fn git_get_commit_context(cwd: &str) -> Result<GitCommitContext, String> {
    let branch = GitTracker::check_branch_internal(cwd);
    let has_head = repo_has_head(cwd);

    let has_upstream =
        GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "@{u}"])
            .map(|o| o.status.success())
            .unwrap_or(false);

    let (mut ahead, mut behind) = (0u32, 0u32);
    if has_upstream {
        if let Some(o) = GitTracker::run_git_command(
            cwd,
            &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        ) {
            if o.status.success() {
                let counts = String::from_utf8_lossy(&o.stdout);
                let parts: Vec<&str> = counts.split_whitespace().collect();
                if parts.len() == 2 {
                    ahead = parts[0].parse().unwrap_or(0);
                    behind = parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    let (last_subject, last_body) = if has_head {
        let subject = GitTracker::run_git_command(cwd, &["log", "-1", "--pretty=%s"])
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
            .unwrap_or_default();
        let body = GitTracker::run_git_command(cwd, &["log", "-1", "--pretty=%b"])
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
            .unwrap_or_default();
        (subject, body)
    } else {
        (String::new(), String::new())
    };

    Ok(GitCommitContext {
        branch,
        has_upstream,
        ahead,
        behind,
        staged_count: staged_entry_count(cwd).unwrap_or(0),
        has_head,
        last_subject,
        last_body,
    })
}

fn is_git_ignored(cwd: &str, path: &str) -> Result<bool, String> {
    let output = GitTracker::run_git_command(cwd, &["check-ignore", "--quiet", "--", path])
        .ok_or_else(|| "Failed to run git check-ignore".to_string())?;

    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}
