//! `gh api graphql` calls and the issue/PR node shape the list and detail
//! queries share.

use std::time::Duration;

use serde::Deserialize;

use super::error::GithubError;
use super::runner::{GhCall, GhRunner};
use super::types::{
    GithubCheckRollup, GithubComment, GithubItemKind, GithubItemState, GithubLabel, GithubListItem,
};

/// Fields every list and detail query selects for an issue or PR.
pub(super) const ITEM_FIELDS: &str = "number title state url updatedAt \
    author { login } \
    labels(first: 20) { nodes { name color } } \
    assignees(first: 10) { nodes { login } }";
pub(super) const PR_ROLLUP_FIELDS: &str =
    "isDraft merged commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
pub(super) const RATE_LIMIT_FIELDS: &str = "rateLimit { limit remaining resetAt }";

/// The GraphQL point budget a response reported.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RateBudget {
    pub limit: u64,
    pub remaining: u64,
    pub reset_at: String,
}

pub(super) enum GraphqlVar<'a> {
    Str(&'a str),
    Int(u64),
}

/// Run a query on `host` and return its `data` object.
pub(super) fn run_graphql(
    runner: &GhRunner,
    host: &str,
    query: &str,
    vars: &[(&str, GraphqlVar<'_>)],
) -> Result<serde_json::Value, GithubError> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={query}"),
    ];
    for (name, value) in vars {
        match value {
            GraphqlVar::Str(text) => args.extend(["-f".to_string(), format!("{name}={text}")]),
            GraphqlVar::Int(number) => args.extend(["-F".to_string(), format!("{name}={number}")]),
        }
    }
    data_of(&runner.stdout(&GhCall::new(Some(host), args))?)
}

/// Run a query or mutation on `host` with the request sent on stdin, so
/// variables (comment bodies) never reach argv or the query text.
pub(super) fn run_graphql_stdin(
    runner: &GhRunner,
    host: &str,
    query: &str,
    variables: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, GithubError> {
    let request = serde_json::json!({ "query": query, "variables": variables });
    let mut call = GhCall::new(Some(host), ["api", "graphql", "--input", "-"])
        .with_stdin(serde_json::to_vec(&request).expect("JSON values serialize"));
    call.timeout = timeout;
    data_of(&runner.stdout(&call)?)
}

fn data_of(stdout: &[u8]) -> Result<serde_json::Value, GithubError> {
    let mut response: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|e| GithubError::Failed(format!("unreadable GraphQL response: {e}")))?;
    match response.get_mut("data").map(serde_json::Value::take) {
        Some(data) if !data.is_null() => Ok(data),
        _ => Err(GithubError::Failed(
            "GraphQL response has no data".to_string(),
        )),
    }
}

pub(super) fn rate_budget(data: &serde_json::Value) -> Option<RateBudget> {
    serde_json::from_value(data.get("rateLimit")?.clone()).ok()
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

impl PageInfo {
    /// The cursor of the next page, when there is one.
    pub fn next(&self) -> Option<&str> {
        self.end_cursor.as_deref().filter(|_| self.has_next_page)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Nodes<T> {
    pub nodes: Vec<Option<T>>,
    #[serde(default)]
    pub page_info: PageInfo,
}

impl<T> Nodes<T> {
    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.nodes.iter().flatten()
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct Login {
    pub login: String,
}

fn login_or_ghost(author: &Option<Login>) -> String {
    author
        .as_ref()
        .map(|a| a.login.clone())
        .unwrap_or_else(|| "ghost".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommentNode {
    pub id: String,
    #[serde(default)]
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub author: Option<Login>,
}

impl CommentNode {
    pub fn to_comment(&self) -> GithubComment {
        GithubComment {
            id: self.id.clone(),
            author: login_or_ghost(&self.author),
            body: self.body.clone(),
            created_at: self.created_at.clone(),
            url: self.url.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Comments {
    pub total_count: u64,
    #[serde(default)]
    pub nodes: Vec<Option<CommentNode>>,
    #[serde(default)]
    pub page_info: PageInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rollup {
    pub state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommitRef {
    pub status_check_rollup: Option<Rollup>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CommitNode {
    pub commit: CommitRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReviewThreadNode {
    pub id: String,
    pub path: String,
    pub line: Option<u64>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Nodes<CommentNode>,
}

/// An `Issue` or `PullRequest` node. List queries leave the detail fields out.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ItemNode {
    #[serde(rename = "__typename")]
    pub typename: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub updated_at: String,
    pub author: Option<Login>,
    pub labels: Option<Nodes<GithubLabel>>,
    pub assignees: Option<Nodes<Login>>,
    pub comments: Option<Comments>,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default)]
    pub merged: bool,
    pub commits: Option<Nodes<CommitNode>>,
    // Detail-only fields.
    pub body: Option<String>,
    pub created_at: Option<String>,
    pub head_ref_name: Option<String>,
    pub head_ref_oid: Option<String>,
    pub base_ref_name: Option<String>,
    pub is_cross_repository: Option<bool>,
    pub maintainer_can_modify: Option<bool>,
    pub mergeable: Option<String>,
    pub merge_state_status: Option<String>,
    pub auto_merge_request: Option<serde_json::Value>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    pub review_threads: Option<Nodes<ReviewThreadNode>>,
}

pub(super) fn rollup_of(state: &str) -> Option<GithubCheckRollup> {
    match state {
        "SUCCESS" => Some(GithubCheckRollup::Success),
        "FAILURE" | "ERROR" => Some(GithubCheckRollup::Failure),
        "PENDING" | "EXPECTED" => Some(GithubCheckRollup::Pending),
        _ => None,
    }
}

impl ItemNode {
    pub fn kind(&self) -> Option<GithubItemKind> {
        match self.typename.as_str() {
            "Issue" => Some(GithubItemKind::Issue),
            "PullRequest" => Some(GithubItemKind::Pr),
            _ => None,
        }
    }

    fn item_state(&self, kind: GithubItemKind) -> GithubItemState {
        match (kind, self.state.as_str()) {
            (GithubItemKind::Pr, _) if self.merged || self.state == "MERGED" => {
                GithubItemState::Merged
            }
            (GithubItemKind::Pr, "OPEN") if self.is_draft => GithubItemState::Draft,
            (_, "OPEN") => GithubItemState::Open,
            _ => GithubItemState::Closed,
        }
    }

    pub fn list_item(&self) -> Option<GithubListItem> {
        let kind = self.kind()?;
        let checks = match kind {
            GithubItemKind::Issue => None,
            GithubItemKind::Pr => self
                .commits
                .as_ref()
                .and_then(|commits| commits.iter().last())
                .and_then(|node| node.commit.status_check_rollup.as_ref())
                .and_then(|rollup| rollup_of(&rollup.state)),
        };
        Some(GithubListItem {
            kind,
            number: self.number,
            title: self.title.clone(),
            state: self.item_state(kind),
            author: login_or_ghost(&self.author),
            labels: self
                .labels
                .as_ref()
                .map(|labels| labels.iter().cloned().collect())
                .unwrap_or_default(),
            assignees: self
                .assignees
                .as_ref()
                .map(|people| people.iter().map(|p| p.login.clone()).collect())
                .unwrap_or_default(),
            comment_count: self.comments.as_ref().map_or(0, |c| c.total_count),
            updated_at: self.updated_at.clone(),
            url: self.url.clone(),
            checks,
        })
    }
}
