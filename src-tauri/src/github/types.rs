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

/// How the list's label filter combines its labels.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum GithubLabelMode {
    /// Items with at least one of the labels.
    #[default]
    Any,
    /// Items with every label.
    All,
    /// Items with none of the labels.
    Exclude,
}

/// Whose items the list shows.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GithubAssigneeFilter {
    #[default]
    Anyone,
    Me,
    /// No assignee.
    Unassigned,
    User {
        login: String,
    },
}

/// List order, newest first.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum GithubSort {
    #[default]
    Updated,
    Created,
    Comments,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubListFilter {
    pub repo: GithubRepoSlot,
    pub kind: GithubKindFilter,
    pub state: GithubStateFilter,
    /// Free text matched against titles and bodies; empty adds nothing.
    #[serde(default)]
    pub search: String,
    /// Label names; empty adds nothing.
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub label_mode: GithubLabelMode,
    #[serde(default)]
    pub assignee: GithubAssigneeFilter,
    pub review_requested: bool,
    #[serde(default)]
    pub sort: GithubSort,
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
    /// The author is a GitHub App or bot account (`__typename: Bot`).
    #[serde(default)]
    pub is_bot: bool,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

/// Why an issue was closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubCloseReason {
    Completed,
    NotPlanned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubTimelineEventKind {
    Labeled,
    Unlabeled,
    Assigned,
    Unassigned,
    Closed,
    Reopened,
    /// PRs only.
    Merged,
}

/// A non-comment event on the item's timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubTimelineEvent {
    pub id: String,
    pub kind: GithubTimelineEventKind,
    /// Who did it; empty when GitHub no longer knows (deleted account).
    pub actor: String,
    pub created_at: String,
    /// Labeled / unlabeled.
    pub label: Option<GithubLabel>,
    /// Assigned / unassigned.
    pub assignee: Option<String>,
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
    /// Label, assignee and open/closed events, oldest first (the latest 50).
    #[serde(default)]
    pub timeline: Vec<GithubTimelineEvent>,
    /// Issues only: why a closed issue was closed.
    #[serde(default)]
    pub state_reason: Option<GithubCloseReason>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoMetaRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoLabel {
    pub name: String,
    /// Six hex digits, no `#`.
    pub color: String,
    pub description: Option<String>,
}

/// What the label and assignee pickers offer for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoMeta {
    pub repo: GithubRepoRef,
    /// The repository's labels by name (first 100).
    pub labels: Vec<GithubRepoLabel>,
    /// Logins that can be assigned (first 100).
    pub assignable_users: Vec<String>,
    /// The signed-in account's login.
    pub viewer: String,
    pub fetched_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubCreateLabelRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub name: String,
    /// Six hex digits, no `#`.
    pub color: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubCreateLabelResult {
    pub label: GithubRepoLabel,
}

/// Add and remove labels and assignees on one issue or PR, by name/login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubEditItemRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub kind: GithubItemKind,
    pub number: u64,
    #[serde(default)]
    pub add_labels: Vec<String>,
    #[serde(default)]
    pub remove_labels: Vec<String>,
    #[serde(default)]
    pub add_assignees: Vec<String>,
    #[serde(default)]
    pub remove_assignees: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubEditItemResult {
    pub number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubItemStateAction {
    /// `reason` applies to issues; a PR close ignores it.
    Close {
        reason: GithubCloseReason,
    },
    Reopen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubSetItemStateRequest {
    pub cwd: String,
    pub repo: GithubRepoSlot,
    pub kind: GithubItemKind,
    pub number: u64,
    pub action: GithubItemStateAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GithubSetItemStateResult {
    pub number: u64,
}
