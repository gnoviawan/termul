use super::{validate_project_path, IpcResult};
use crate::acp::destructive_guard::{ensure_no_active_turn_in_checkout, start_ref_rewrites_tree};
use crate::acp::AcpManager;
use crate::trackers::git_tracker::{CommitDetailError, GitCommitDetail, GitCommitFileDiff};
use crate::trackers::git_tracker::{CommitFailure, CommitStamp};
use crate::trackers::git_tracker::{DiffStatError, GitDiffStat};
use crate::trackers::{GitCommit, GitStatusDetail};
use crate::web::command_ledger::{
    fingerprint_of, no_entity, run_domain, run_domain_released, DomainRan, PRECONDITION_FAILED_PREFIX,
};
use crate::web::git_api::{commit_entity, commit_fingerprint, expected_head_malformed};
use crate::web::WsRelaySink;
use std::sync::Arc;
use tauri::State;

// ==================== Git Commands ====================

/// Get git status for a repository
#[tauri::command]
pub async fn git_get_status(cwd: String) -> Result<Vec<GitStatusDetail>, String> {
    // Git runs off the async workers (as `web/git_api.rs` does): an all-repo
    // refresh must not starve IPC, ACP and the WS relay.
    tokio::task::spawn_blocking(move || crate::trackers::git_tracker::git_get_status_detail(&cwd))
        .await
        .map_err(|e| format!("git status task failed: {e}"))?
}

/// Get git diff for a file. `staged` selects the index-vs-HEAD diff
/// (`git diff --cached`) instead of the worktree-vs-index diff.
#[tauri::command]
pub async fn git_get_diff(
    cwd: String,
    path: String,
    staged: Option<bool>,
) -> Result<String, String> {
    let staged = staged.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        crate::trackers::git_tracker::git_get_diff(&cwd, &path, staged)
    })
    .await
    .map_err(|e| format!("git diff task failed: {e}"))?
}

/// Working-tree `+added -removed` line stat for the repository at `cwd`
/// (tracked changes against HEAD plus untracked files). Read-only; the same
/// shared function backs `POST /git/diff-stat`. Failures surface as
/// `IpcResult::error(.., DiffStatError::code())`.
#[tauri::command]
pub async fn git_get_diff_stat(cwd: String) -> Result<IpcResult<GitDiffStat>, String> {
    let cwd = match validate_project_path(&cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[git_get_diff_stat] invalid cwd: {e}");
            return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED"));
        }
    };
    let result: Result<GitDiffStat, DiffStatError> =
        tokio::task::spawn_blocking(move || crate::trackers::git_tracker::git_get_diff_stat(&cwd))
            .await
            .map_err(|e| format!("git diff stat task failed: {e}"))?;
    Ok(match result {
        Ok(stat) => IpcResult::success(stat),
        Err(e) => IpcResult::error(e.to_string(), e.code()),
    })
}

/// Stage a single file (`git add`).
#[tauri::command]
pub async fn git_stage(cwd: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::trackers::git_tracker::git_stage_file(&cwd, &path))
        .await
        .map_err(|e| format!("git stage task failed: {e}"))?
}

/// Unstage a single file (`git restore --staged`).
#[tauri::command]
pub async fn git_unstage(cwd: String, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::trackers::git_tracker::git_unstage_file(&cwd, &path)
    })
    .await
    .map_err(|e| format!("git unstage task failed: {e}"))?
}

/// Stage a single hunk. `hunk_patch` is a unified-diff fragment
/// (`--- a/<path>` / `+++ b/<path>` / `@@ … @@` / body) built by the
/// renderer from the working-tree diff. See #257.
#[tauri::command]
pub async fn git_stage_hunk(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    path: String,
    hunk_patch: String,
    command_id: Option<String>,
) -> Result<(), String> {
    // The fingerprint names the file, never the patch.
    let print = fingerprint_of("git_stage_hunk", &[("cwd", &cwd), ("path", &path)]);
    run_domain(relay.ledger(), "git_stage_hunk", command_id, print, no_entity(), async move {
        tokio::task::spawn_blocking(move || {
            crate::trackers::git_tracker::git_stage_hunk(&cwd, &path, &hunk_patch)
        })
        .await
        .map_err(|e| format!("git stage hunk task failed: {e}"))?
    })
    .await
}

/// Unstage a single hunk. `hunk_patch` is built from the staged diff and
/// reverse-applied to the index. See #257.
#[tauri::command]
pub async fn git_unstage_hunk(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    path: String,
    hunk_patch: String,
    command_id: Option<String>,
) -> Result<(), String> {
    let print = fingerprint_of("git_unstage_hunk", &[("cwd", &cwd), ("path", &path)]);
    run_domain(
        relay.ledger(),
        "git_unstage_hunk",
        command_id,
        print,
        no_entity(),
        async move {
            tokio::task::spawn_blocking(move || {
                crate::trackers::git_tracker::git_unstage_hunk(&cwd, &path, &hunk_patch)
            })
            .await
            .map_err(|e| format!("git unstage hunk task failed: {e}"))?
        },
    )
    .await
}

/// Discard changes to a single file. Untracked files are deleted; tracked
/// changes revert to HEAD. This is destructive and irreversible.
#[tauri::command]
pub async fn git_discard(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    path: String,
    command_id: Option<String>,
) -> Result<(), String> {
    let print = fingerprint_of("git_discard", &[("cwd", &cwd), ("path", &path)]);
    run_domain(relay.ledger(), "git_discard", command_id, print, no_entity(), async move {
        tokio::task::spawn_blocking(move || {
            crate::trackers::git_tracker::git_discard_file(&cwd, &path)
        })
        .await
        .map_err(|e| format!("git discard task failed: {e}"))?
    })
    .await
}

/// Read commit history for the repository at `cwd` as structured rows for the
/// history/graph view. `limit` caps the number of commits (clamped backend-side;
/// defaults to 200); `all` walks every ref instead of `HEAD`. Read-only; git runs
/// off the async runtime and the cwd is validated like the other history reads.
#[tauri::command]
pub async fn git_get_log(
    cwd: String,
    limit: Option<u32>,
    all: Option<bool>,
) -> Result<Vec<GitCommit>, String> {
    let cwd = match validate_project_path(&cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[git_get_log] invalid cwd: {e}");
            return Err(e);
        }
    };
    let all = all.unwrap_or(false);
    tokio::task::spawn_blocking(move || crate::trackers::git_tracker::git_get_log(&cwd, limit, all))
        .await
        .map_err(|e| format!("git log task failed: {e}"))?
}

/// Message, author email, parents and changed files of one commit for the
/// Git History detail pane. Read-only; the same shared function backs
/// `POST /git/commit-detail`. A hash that is not 4–64 hex characters is refused
/// before git runs (`INVALID_COMMIT_HASH`).
#[tauri::command]
pub async fn git_get_commit_detail(
    cwd: String,
    hash: String,
) -> Result<IpcResult<GitCommitDetail>, String> {
    let cwd = match validate_project_path(&cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[git_get_commit_detail] invalid cwd: {e}");
            return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED"));
        }
    };
    let result: Result<GitCommitDetail, CommitDetailError> =
        tokio::task::spawn_blocking(move || {
            crate::trackers::git_tracker::git_get_commit_detail(&cwd, &hash)
        })
        .await
        .map_err(|e| format!("git commit detail task failed: {e}"))?;
    Ok(match result {
        Ok(detail) => IpcResult::success(detail),
        Err(e) => IpcResult::error(e.to_string(), e.code()),
    })
}

/// Unified diff of one file in a commit against its first parent, for the
/// read-only commit Diff tab. Same shared function as
/// `POST /git/commit-file-diff`. `old_path` is a rename's source path. A diff
/// over the size cap comes back as `{ diff: "", tooLarge: true }`.
#[tauri::command]
pub async fn git_get_commit_file_diff(
    cwd: String,
    hash: String,
    path: String,
    old_path: Option<String>,
) -> Result<IpcResult<GitCommitFileDiff>, String> {
    let cwd = match validate_project_path(&cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[git_get_commit_file_diff] invalid cwd: {e}");
            return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED"));
        }
    };
    let result: Result<GitCommitFileDiff, CommitDetailError> =
        tokio::task::spawn_blocking(move || {
            crate::trackers::git_tracker::git_get_commit_file_diff(
                &cwd,
                &hash,
                &path,
                old_path.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("git commit file diff task failed: {e}"))?;
    Ok(match result {
        Ok(diff) => IpcResult::success(diff),
        Err(e) => IpcResult::error(e.to_string(), e.code()),
    })
}

/// Create a commit from the staged index. `amend` rewrites HEAD instead of
/// adding a new commit. The message is passed via a temp file, not `-m`.
///
/// `expected_head` (the full sha, or empty for an unborn branch) refuses the
/// commit with a `precondition_failed: …` error when `HEAD` is elsewhere. A
/// `command_id` stamps the commit (`Termul-Command-Id:` trailer) so a resend
/// answers from the commit it made instead of committing again.
#[tauri::command]
pub async fn git_commit(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    summary: String,
    description: Option<String>,
    amend: Option<bool>,
    expected_head: Option<String>,
    command_id: Option<String>,
) -> Result<(), String> {
    if expected_head_malformed(expected_head.as_deref()) {
        return Err(commit_failure_text(CommitFailure::InvalidExpectedHead));
    }
    let description = description.unwrap_or_default();
    let amend = amend.unwrap_or(false);
    let lookup = {
        let (cwd, id, head) = (cwd.clone(), command_id.clone(), expected_head.clone());
        move || commit_entity(cwd.clone(), id.clone(), head.clone())
    };
    let print = commit_fingerprint(&cwd, amend, expected_head.as_deref());
    let stamp_id = command_id.clone();
    run_domain(
        relay.ledger(),
        "git_commit",
        command_id,
        print,
        lookup,
        async move {
            // git_commit_stamped runs `git commit` (which can block on hooks / GPG
            // prompts for up to the network timeout), so run it on the blocking
            // thread pool instead of the async executor.
            tauri::async_runtime::spawn_blocking(move || {
                let stamp = CommitStamp {
                    command_id: stamp_id.as_deref(),
                    expected_head: expected_head.as_deref(),
                };
                crate::trackers::git_tracker::git_commit_stamped(
                    &cwd,
                    &summary,
                    &description,
                    amend,
                    &stamp,
                )
                .map_err(commit_failure_text)
            })
            .await
            .map_err(|e| format!("git commit task failed: {e}"))?
        },
    )
    .await
}

/// The error text of a refused commit: a stable code prefix for the two
/// refusals the caller can act on, git's own text otherwise.
pub(crate) fn commit_failure_text(failure: CommitFailure) -> String {
    match failure {
        CommitFailure::PreconditionFailed { .. } => {
            format!("{PRECONDITION_FAILED_PREFIX}: {failure}")
        }
        CommitFailure::InvalidExpectedHead => format!("validation_error: {failure}"),
        CommitFailure::Failed(message) => message,
    }
}

/// Push the current branch to `origin`, setting upstream when none exists.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<(), String> {
    // git_push_current performs a network push (up to the network timeout), so
    // run it on the blocking thread pool instead of the async executor.
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_push_current(&cwd)
    })
    .await
    .map_err(|e| format!("git push task failed: {e}"))?
}

/// Get commit-footer context: branch, upstream, ahead/behind, staged count,
/// and the last commit's subject/body (for prefilling an amend).
#[tauri::command]
pub async fn git_get_commit_context(
    cwd: String,
) -> Result<crate::trackers::git_tracker::GitCommitContext, String> {
    tokio::task::spawn_blocking(move || {
        crate::trackers::git_tracker::git_get_commit_context(&cwd)
    })
    .await
    .map_err(|e| format!("git commit context task failed: {e}"))?
}

#[tauri::command]
pub async fn git_init(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(&cwd, &["init"])
            .ok_or_else(|| "Failed to run git init".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git init task failed: {e}"))?
}

/// Check out an existing local or remote-tracking branch. Refused with a
/// `destructive_op_blocked: …` error while a session working inside the work
/// tree is mid-turn (identical text on the HTTP route).
#[tauri::command]
pub async fn git_checkout_branch(
    manager: State<'_, Arc<AcpManager>>,
    cwd: String,
    branch: String,
    is_remote: Option<bool>,
) -> Result<(), String> {
    checkout_branch_guarded(&manager, cwd, branch, is_remote.unwrap_or(false)).await
}

/// Body of [`git_checkout_branch`] (guard, then checkout) taking the manager
/// directly so tests can drive the desktop entry point without a Tauri app.
pub(crate) async fn checkout_branch_guarded(
    acp: &AcpManager,
    cwd: String,
    branch: String,
    is_remote: bool,
) -> Result<(), String> {
    ensure_no_active_turn_in_checkout(acp, std::path::Path::new(&cwd))
        .await
        .map_err(|blocked| blocked.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_checkout_branch(&cwd, &branch, is_remote)
    })
    .await
    .map_err(|e| format!("git checkout task failed: {e}"))?
}

/// Create a new branch from `start_ref` (defaults to HEAD) and check it out.
/// A start ref other than HEAD is refused with `destructive_op_blocked: …`
/// while a session working inside the work tree is mid-turn.
#[tauri::command]
pub async fn git_create_branch(
    manager: State<'_, Arc<AcpManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    branch: String,
    start_ref: Option<String>,
    command_id: Option<String>,
) -> Result<(), String> {
    create_branch_ledgered(
        relay.ledger(),
        Arc::clone(manager.inner()),
        cwd,
        branch,
        start_ref,
        command_id,
    )
    .await
}

/// Body of [`git_create_branch`] taking the ledger and manager directly so
/// tests can drive the desktop entry point without a Tauri app.
pub(crate) async fn create_branch_ledgered(
    ledger: &Arc<crate::web::command_ledger::CommandLedger>,
    manager: Arc<AcpManager>,
    cwd: String,
    branch: String,
    start_ref: Option<String>,
    command_id: Option<String>,
) -> Result<(), String> {
    let print = fingerprint_of("git_create_branch", &[("cwd", &cwd), ("branch", &branch)]);
    run_domain_released(
        ledger,
        "git_create_branch",
        command_id,
        print,
        no_entity(),
        async move {
            // The guard runs INSIDE the ledgered effect: a settled outcome
            // replays before it, and a refusal is released (not recorded) so a
            // retry after the turn ends runs.
            if let Err(blocked) = guard_create_branch(&manager, &cwd, start_ref.as_deref()).await {
                return DomainRan::Released(blocked);
            }
            DomainRan::Settled(create_branch_unguarded(cwd, branch, start_ref).await)
        },
    )
    .await
}

/// The destructive-op guard of [`git_create_branch`]: `Err` is the refusal text.
async fn guard_create_branch(
    acp: &AcpManager,
    cwd: &str,
    start_ref: Option<&str>,
) -> Result<(), String> {
    // Branching from HEAD leaves the work tree alone; branching from another
    // `start_ref` checks that ref out, which rewrites it.
    if start_ref_rewrites_tree(start_ref) {
        ensure_no_active_turn_in_checkout(acp, std::path::Path::new(cwd))
            .await
            .map_err(|blocked| blocked.to_string())?;
    }
    Ok(())
}

async fn create_branch_unguarded(
    cwd: String,
    branch: String,
    start_ref: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_create_branch(&cwd, &branch, start_ref.as_deref())
    })
    .await
    .map_err(|e| format!("git create branch task failed: {e}"))?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashInfo {
    pub index: usize,
    pub name: String,
    pub message: String,
}

#[tauri::command]
pub async fn git_stash_save(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    message: Option<String>,
    include_untracked: Option<bool>,
    command_id: Option<String>,
) -> Result<(), String> {
    let print = fingerprint_of("git_stash_save", &[("cwd", &cwd)]);
    run_domain(
        relay.ledger(),
        "git_stash_save",
        command_id,
        print,
        no_entity(),
        stash_save_effect(cwd, message, include_untracked),
    )
    .await
}

async fn stash_save_effect(
    cwd: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["stash", "push"];
        if let Some(true) = include_untracked {
            args.push("-u");
        }
        let msg;
        if let Some(ref m) = message {
            args.push("-m");
            msg = m.clone();
            args.push(&msg);
        }
        let output =
            crate::trackers::git_tracker::GitTracker::run_git_command(&validated_str, &args)
                .ok_or_else(|| "Failed to run git stash push".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash push task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_list(cwd: String) -> Result<Vec<GitStashInfo>, String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", "list"],
        )
        .ok_or_else(|| "Failed to run git stash list".to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut stashes = Vec::new();
        for line in stdout.lines() {
            if let Some((stash_part, rest)) = line.split_once(':') {
                let name = stash_part.trim().to_string();
                if let Some(start) = name.find('{') {
                    if let Some(end) = name.find('}') {
                        if let Ok(index) = name[start + 1..end].parse::<usize>() {
                            let message = rest.trim().to_string();
                            stashes.push(GitStashInfo {
                                index,
                                name,
                                message,
                            });
                        }
                    }
                }
            }
        }
        Ok(stashes)
    })
    .await
    .map_err(|e| format!("git stash list task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_apply(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    index: usize,
    command_id: Option<String>,
) -> Result<(), String> {
    let index_text = index.to_string();
    let print = fingerprint_of("git_stash_apply", &[("cwd", &cwd), ("index", &index_text)]);
    run_domain(
        relay.ledger(),
        "git_stash_apply",
        command_id,
        print,
        no_entity(),
        stash_index_effect(cwd.clone(), index, "apply"),
    )
    .await
}

#[tauri::command]
pub async fn git_stash_pop(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    index: usize,
    command_id: Option<String>,
) -> Result<(), String> {
    let index_text = index.to_string();
    let print = fingerprint_of("git_stash_pop", &[("cwd", &cwd), ("index", &index_text)]);
    run_domain(
        relay.ledger(),
        "git_stash_pop",
        command_id,
        print,
        no_entity(),
        stash_index_effect(cwd.clone(), index, "pop"),
    )
    .await
}

#[tauri::command]
pub async fn git_stash_drop(
    relay: State<'_, Arc<WsRelaySink>>,
    cwd: String,
    index: usize,
    command_id: Option<String>,
) -> Result<(), String> {
    let index_text = index.to_string();
    let print = fingerprint_of("git_stash_drop", &[("cwd", &cwd), ("index", &index_text)]);
    run_domain(
        relay.ledger(),
        "git_stash_drop",
        command_id,
        print,
        no_entity(),
        stash_index_effect(cwd.clone(), index, "drop"),
    )
    .await
}

async fn stash_index_effect(cwd: String, index: usize, op: &'static str) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{}}}", index);
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", op, &stash_ref],
        )
        .ok_or_else(|| format!("Failed to run git stash {op}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash {op} task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<Vec<String>, String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["branch", "-a", "--format=%(refname:short)"],
        )
        .ok_or_else(|| "Failed to run git branch".to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut branches = Vec::new();
        for line in stdout.lines() {
            let name = line.trim();
            if !name.is_empty() {
                branches.push(name.to_string());
            }
        }
        Ok(branches)
    })
    .await
    .map_err(|e| format!("git branch list task failed: {e}"))?
}

/// `git checkout <name>`. Refused with a `destructive_op_blocked: …` error
/// while a session working inside the work tree is mid-turn.
#[tauri::command]
pub async fn git_branch_switch(
    manager: State<'_, Arc<AcpManager>>,
    cwd: String,
    name: String,
) -> Result<(), String> {
    branch_switch_guarded(&manager, cwd, name).await
}

/// Body of [`git_branch_switch`], see [`checkout_branch_guarded`].
pub(crate) async fn branch_switch_guarded(
    acp: &AcpManager,
    cwd: String,
    name: String,
) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    ensure_no_active_turn_in_checkout(acp, &validated)
        .await
        .map_err(|blocked| blocked.to_string())?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["checkout", &name],
        )
        .ok_or_else(|| "Failed to run git checkout".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git branch switch task failed: {e}"))?
}

#[cfg(test)]
mod guard_tests;
