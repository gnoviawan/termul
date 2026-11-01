//! Wire types for the GitHub issues & PRs contract. These mirror
//! `src/shared/types/github.types.ts` field for field (camelCase JSON, tagged
//! unions keyed by `state`/`kind`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubRepoSlot {
    Origin,
    Upstream,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubRepoRef {
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl GithubRepoRef {
    /// `HOST/OWNER/NAME`, the `--repo` form that pins `gh` to the host.
    pub fn qualified(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.name)
    }
}

impl std::fmt::Display for GithubRepoRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.qualified())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubTokenSource {
    Keyring,
    Env,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GithubAuthStatus {
    CliMissing,
    Unauthenticated {
        host: String,
        login_command: String,
    },
    Connected {
        host: String,
        account: String,
        scopes: Vec<String>,
        token_source: GithubTokenSource,
        missing_scopes: Vec<String>,
        fix_commands: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubRepoResolution {
    NotGithub,
    Resolved {
        origin: GithubRepoRef,
        upstream: Option<GithubRepoRef>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubContext {
    pub auth: GithubAuthStatus,
    pub repo: GithubRepoResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubContextRequest {
    pub cwd: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubItemKind {
    Issue,
    Pr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubItemState {
    Open,
    Closed,
    Merged,
    Draft,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckRollup {
    Success,
    Failure,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubListItem {
    pub kind: GithubItemKind,
    pub number: u64,
    pub title: String,
    pub state: GithubItemState,
    pub author: String,
    pub labels: Vec<GithubLabel>,
    pub assignees: Vec<String>,
    pub comment_count: u64,
    pub updated_at: String,
    pub url: String,
    pub checks: Option<GithubCheckRollup>,
}

/// `'all' | GithubItemKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubKindFilter {
    All,
    Issue,
    Pr,
}

/// `'all' | GithubItemState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubStateFilter {
    All,
    Open,
    Closed,
    Merged,
    Draft,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubListFilter {
    pub repo: GithubRepoSlot,
    pub kind: GithubKindFilter,
    pub state: GithubStateFilter,
    pub assigned_to_me: bool,
    pub review_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubListRequest {
    pub cwd: String,
    pub filter: GithubListFilter,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubListResult {
    pub repo: GithubRepoRef,
    pub items: Vec<GithubListItem>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubItemRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub kind: GithubItemKind,
    pub number: u64,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u64>,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<GithubComment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubMergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullDetail {
    pub head_ref_name: String,
    pub head_sha: String,
    pub base_ref_name: String,
    pub is_cross_repository: bool,
    pub maintainer_can_modify: bool,
    pub mergeable: GithubMergeable,
    pub merge_state_status: String,
    pub auto_merge_enabled: bool,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub review_threads: Vec<GithubReviewThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubItemDetail {
    pub repo: GithubRepoRef,
    pub item: GithubListItem,
    pub body: String,
    pub created_at: String,
    pub comments: Vec<GithubComment>,
    pub pr: Option<GithubPullDetail>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckStatus {
    Success,
    Failure,
    Pending,
    Skipped,
    Neutral,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheck {
    pub name: String,
    pub workflow: Option<String>,
    pub status: GithubCheckStatus,
    pub details_url: Option<String>,
    pub job_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubChecksRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub number: u64,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubChecksResult {
    pub head_sha: String,
    pub rollup: Option<GithubCheckRollup>,
    pub checks: Vec<GithubCheck>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckLogRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub job_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckLog {
    pub job_id: u64,
    pub tail: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubMergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl GithubMergeMethod {
    pub fn flag(self) -> &'static str {
        match self {
            Self::Merge => "--merge",
            Self::Squash => "--squash",
            Self::Rebase => "--rebase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubMergeAction {
    Merge { method: GithubMergeMethod },
    EnableAutoMerge { method: GithubMergeMethod },
    DisableAutoMerge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubMergeRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub number: u64,
    pub action: GithubMergeAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubMergeResult {
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GithubCommentTarget {
    Conversation,
    ReviewThread { thread_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCommentRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub kind: GithubItemKind,
    pub number: u64,
    pub target: GithubCommentTarget,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubCommentResult {
    pub comment: GithubComment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckoutPrRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckoutPrResult {
    pub head_sha: String,
    pub head_ref_name: String,
    pub push_command: String,
}
