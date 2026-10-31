//! One issue or PR with its body, conversation and review threads (CAP-3),
//! and the merge-state read the merge op decides on (CAP-4).

use super::error::GithubError;
use super::graphql::{ItemNode, ITEM_FIELDS, PR_ROLLUP_FIELDS, RATE_LIMIT_FIELDS};
use super::types::{GithubItemKind, GithubMergeable, GithubPullDetail, GithubReviewThread};

const COMMENT_FIELDS: &str = "id body createdAt url author { login }";

pub(super) fn detail_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ issueOrPullRequest(number: $number) {{ __typename \
         ... on Issue {{ {ITEM_FIELDS} body createdAt \
           comments(first: 100) {{ totalCount nodes {{ {COMMENT_FIELDS} }} }} }} \
         ... on PullRequest {{ {ITEM_FIELDS} body createdAt {PR_ROLLUP_FIELDS} \
           comments(first: 100) {{ totalCount nodes {{ {COMMENT_FIELDS} }} }} \
           headRefName headRefOid baseRefName isCrossRepository maintainerCanModify \
           mergeable mergeStateStatus autoMergeRequest {{ enabledAt }} \
           additions deletions changedFiles \
           reviewThreads(first: 100) {{ nodes {{ id isResolved isOutdated path line \
             comments(first: 50) {{ nodes {{ {COMMENT_FIELDS} }} }} }} }} \
         }} }} }} }}"
    )
}

/// The fields `merge` re-reads before deciding.
pub(super) fn merge_state_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ \
         state headRefOid mergeStateStatus }} }} }}"
    )
}

pub(super) struct MergeState {
    pub state: String,
    pub head_sha: String,
    pub merge_state_status: String,
}

pub(super) fn parse_merge_state(data: &serde_json::Value) -> Result<MergeState, GithubError> {
    let pr = data
        .pointer("/repository/pullRequest")
        .filter(|pr| !pr.is_null())
        .ok_or_else(|| GithubError::NotFound("pull request".to_string()))?;
    let field = |name: &str| {
        pr.get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Ok(MergeState {
        state: field("state"),
        head_sha: field("headRefOid"),
        merge_state_status: field("mergeStateStatus"),
    })
}

pub(super) fn parse_item_node(
    data: &serde_json::Value,
    expected: GithubItemKind,
    number: u64,
) -> Result<ItemNode, GithubError> {
    let node = data
        .pointer("/repository/issueOrPullRequest")
        .filter(|node| !node.is_null())
        .ok_or_else(|| GithubError::NotFound(format!("#{number}")))?;
    let node: ItemNode = serde_json::from_value(node.clone())
        .map_err(|e| GithubError::Failed(format!("unreadable item #{number}: {e}")))?;
    if node.kind() != Some(expected) {
        let wanted = match expected {
            GithubItemKind::Issue => "an issue",
            GithubItemKind::Pr => "a pull request",
        };
        return Err(GithubError::NotFound(format!("#{number} is not {wanted}")));
    }
    Ok(node)
}

pub(super) fn pull_detail(node: &ItemNode) -> GithubPullDetail {
    let mergeable = match node.mergeable.as_deref() {
        Some("MERGEABLE") => GithubMergeable::Mergeable,
        Some("CONFLICTING") => GithubMergeable::Conflicting,
        _ => GithubMergeable::Unknown,
    };
    let review_threads = node
        .review_threads
        .as_ref()
        .map(|threads| {
            threads
                .iter()
                .map(|thread| GithubReviewThread {
                    id: thread.id.clone(),
                    path: thread.path.clone(),
                    line: thread.line,
                    is_resolved: thread.is_resolved,
                    is_outdated: thread.is_outdated,
                    comments: thread.comments.iter().map(|c| c.to_comment()).collect(),
                })
                .collect()
        })
        .unwrap_or_default();
    GithubPullDetail {
        head_ref_name: node.head_ref_name.clone().unwrap_or_default(),
        head_sha: node.head_ref_oid.clone().unwrap_or_default(),
        base_ref_name: node.base_ref_name.clone().unwrap_or_default(),
        is_cross_repository: node.is_cross_repository.unwrap_or(false),
        maintainer_can_modify: node.maintainer_can_modify.unwrap_or(false),
        mergeable,
        merge_state_status: node
            .merge_state_status
            .clone()
            .unwrap_or_else(|| "UNKNOWN".to_string()),
        auto_merge_enabled: node.auto_merge_request.is_some(),
        additions: node.additions.unwrap_or(0),
        deletions: node.deletions.unwrap_or(0),
        changed_files: node.changed_files.unwrap_or(0),
        review_threads,
    }
}
