//! The ledgered git commit: the effect (stamp + `expectedHead`) and the
//! trailer lookup of a resend, used by `/git/commit` and the desktop
//! `git_commit` command. Only the commit is found by a stamp; a branch cannot
//! carry one, so create-branch has no entity lookup.

use axum::http::HeaderMap;

use crate::trackers::git_tracker::{self, CommitFailure, CommitStamp};
use crate::web::command_ledger::{
    command_id_from_headers, fingerprint_of, found_entity, run_http, Settled, PRECONDITION_FAILED_CODE,
};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

use super::GitCommitRequest;

/// The identity of a `git_commit` request, shared by the HTTP route and the
/// Tauri command: where, whether it amends, and the head it expects (an empty
/// `expectedHead` is the unborn branch, distinct from none). Never the message.
pub(crate) fn commit_fingerprint(
    cwd: &str,
    amend: bool,
    expected_head: Option<&str>,
) -> crate::web::command_ledger::Fingerprint {
    let mut fields = vec![("cwd", cwd), ("amend", if amend { "true" } else { "false" })];
    if let Some(head) = expected_head {
        fields.push(("expectedHead", if head.trim().is_empty() { "unborn" } else { head }));
    }
    fingerprint_of("git_commit", &fields)
}

/// Whether a request's `expectedHead` is present but malformed.
pub(crate) fn expected_head_malformed(head: Option<&str>) -> bool {
    head.is_some_and(|head| !git_tracker::is_valid_expected_head(head))
}

/// The commit a resend made: found through its `Termul-Command-Id` trailer
/// between `expected_head` and `HEAD`.
pub(crate) async fn commit_entity(
    cwd: String,
    command_id: Option<String>,
    expected_head: Option<String>,
) -> Option<Settled> {
    let command_id = command_id?;
    tokio::task::spawn_blocking(move || {
        git_tracker::find_stamped_commit(&cwd, &command_id, expected_head.as_deref())
    })
    .await
    .ok()
    .flatten()
    .map(|_| found_entity())
}

/// `POST /git/commit` after the guard and path resolution: refuse a stale
/// `expectedHead`, stamp the commit with the `commandId`, and answer a resend
/// from the commit it made.
pub(super) async fn commit(
    state: &AppState,
    headers: &HeaderMap,
    cwd: String,
    req: GitCommitRequest,
) -> IpcBody<()> {
    if expected_head_malformed(req.expected_head.as_deref()) {
        return IpcBody::err(CommitFailure::InvalidExpectedHead.to_string(), "VALIDATION_ERROR");
    }
    let command_id = command_id_from_headers::<()>(headers).ok().flatten();
    let GitCommitRequest {
        cwd: raw_cwd,
        summary,
        description,
        amend,
        expected_head,
    } = req;
    let lookup = {
        let (cwd, id, head) = (cwd.clone(), command_id.clone(), expected_head.clone());
        move || commit_entity(cwd.clone(), id.clone(), head.clone())
    };
    run_http(
        state.relay.ledger(),
        headers,
        "git_commit",
        commit_fingerprint(&raw_cwd, amend, expected_head.as_deref()),
        lookup,
        async move {
            let result = tokio::task::spawn_blocking({
                let cwd = cwd.clone();
                move || {
                    let stamp = CommitStamp {
                        command_id: command_id.as_deref(),
                        expected_head: expected_head.as_deref(),
                    };
                    git_tracker::git_commit_stamped(&cwd, &summary, &description, amend, &stamp)
                }
            })
            .await
            .map_err(|e| format!("git commit task failed: {e}"));
            match result {
                Ok(Ok(())) => {
                    tracing::info!(path = %cwd, amend, "git commit ok");
                    IpcBody::ok(())
                }
                Ok(Err(failure @ CommitFailure::PreconditionFailed { .. })) => {
                    tracing::warn!(path = %cwd, "git commit refused: HEAD moved");
                    IpcBody::err(failure.to_string(), PRECONDITION_FAILED_CODE)
                }
                Ok(Err(CommitFailure::InvalidExpectedHead)) => IpcBody::err(
                    CommitFailure::InvalidExpectedHead.to_string(),
                    "VALIDATION_ERROR",
                ),
                Ok(Err(CommitFailure::Failed(e))) => {
                    tracing::warn!(path = %cwd, error = %e, "git commit failed");
                    IpcBody::err(e, "GIT_COMMIT_ERROR")
                }
                Err(e) => {
                    tracing::error!(path = %cwd, error = %e, "git commit task panicked");
                    IpcBody::err(
                        format!("git commit task failed: {e}"),
                        "GIT_COMMIT_ERROR",
                    )
                }
            }
        },
    )
    .await
}
