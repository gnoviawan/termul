//! One row per method and path [`crate::web::router::router`] registers. The
//! tests next to this module fail when a registered route has no row here, or
//! a row has no registered route.

use schemars::JsonSchema;
use serde::Serialize;

use super::{ApiRoute, Reply, Tag};
use crate::acp::browser_policy::{AppPolicyView, ProjectPolicyView};
use crate::acp::catalog::{AcpCatalog, SetCatalogOptInRequest};
use crate::acp::install::{InstallOutcome, InstallRequest};
use crate::acp::mcp_probe::{McpServerConfig, ProbeResult};
use crate::automation::agents::KnownAgent;
use crate::automation::model::{ApplyOpsResult, Automation, Run, Step};
use crate::automation::service::AutomationDetail;
use crate::automation::suggest::Suggestion;
use crate::canvas::persistence::{
    CloseOutcome, DirtyOutcome, DiskOutcome, DocumentBytes, PersistenceView, Remount,
    ResolveOutcome, WriteOutcome,
};
use crate::canvas::static_server::CanvasOpenInfo;
use crate::commands::automation::SchedulePreview;
use crate::commands::search::{
    FileSearchResponse, RgInfoResponse, SearchContentCancelRequest, SearchContentRequest,
};
use crate::diagnostics::{BugReportContext, BugReportSubmitRequest, BugReportSubmitResult};
use crate::github::*;
use crate::mcp_catalog::{
    CancelRequest, CommitRequest, CommitResult, FormReply, FormRequest, McpCatalogPage,
    McpCatalogSearchRequest, McpCatalogStatus, PlanReply, PlanRequest,
};
use crate::project_icon::ProjectIcon;
use crate::skills::files::SkillFileEntry;
use crate::skills::{AgentSkillContent, AgentSkillSummary};
use crate::trackers::git_tracker::{
    GitCommit, GitCommitContext, GitCommitDetail, GitCommitFileDiff, GitDiffStat, GitStatusDetail,
};
use crate::web::acp_api::{FactoryKeySave, FactoryKeyStatus};
use crate::web::agent_reaper::AgentIdleWindowStatus;
use crate::web::automation_api as automation;
use crate::web::browser_policy_api::{self as browser_policy, ApplyAppBody, ApplyProjectBody};
use crate::web::canvas_api::{CanvasCloseRequest, CanvasOpenRequest};
use crate::web::canvas_persistence_api as canvas;
use crate::web::catalog_api::CatalogQuery;
use crate::web::fs_api::{
    CopyRequest, DeleteRequest, DirectoryEntryDto, FileContentDto, FileInfoDto, GitInitRequest,
    MkdirRequest, PathQuery, RenameRequest, WriteRequest,
};
use crate::web::git_api::{
    GitBranchNameRequest, GitCheckoutBranchRequest, GitCommitRequest, GitCreateBranchRequest,
    GitCwdQuery, GitCwdRequest, GitDiffRequest, GitLogRequest, GitPathRequest,
    GitStashIndexRequest, GitStashInfoDto, GitStashSaveRequest,
};
use crate::web::git_history_api::{GitCommitDetailRequest, GitCommitFileDiffRequest};
use crate::web::git_hunk_api::GitHunkRequest;
use crate::web::log_api::FrontendErrorRequest;
use crate::web::mcp_catalog_api::{SetMcpCatalogSyncRequest, WithClient};
use crate::web::mcp_oauth_api::{
    OAuthCallbackQuery, OAuthStartRequest, OAuthStartResponse, OAuthStatusRequest,
    OAuthStatusResponse,
};
use crate::web::mcp_servers_api::McpProjectQuery;
use crate::web::project_icon_api::ProjectIconRequest;
use crate::web::project_registry::{ProjectListPayload, ProjectSummary};
use crate::web::projects_api::{
    RemoveProjectQuery, SetDefaultProjectRequest, UpdateProjectRequest, UpsertProjectRequest,
};
use crate::web::router::host_routes::{HealthBody, SetAgentIdleWindowRequest};
use crate::web::router::server_config::{
    ServerConfigFieldErrors, ServerConfigResponse, SetupApplyResponse,
};
use crate::web::search_api::{FileNameSearchResponse, SearchFileNamesQuery};
use crate::web::server_config_file::ServerSetupAnswers;
use crate::web::skills_api::SkillsQuery;
use crate::web::worktree_api::{
    WebWorktreeEntry, WorktreeCopyIncludeRequest, WorktreeCreateRequest, WorktreePathQuery,
    WorktreeProjectPathQuery, WorktreeProjectPathRequest, WorktreeRemoveRequest,
    WorktreeSymlinksRequest,
};
use crate::web::worktree_rename_api::WorktreeRenameBranchRequest;
use crate::worktree::{
    BaseBranchInfo, BranchEntry, DirtyStatus, GitWorktreeEntry, GitignoreDir, IncludeCopyResult,
    SymlinkResult,
};
use crate::DetectedShells;

/// `POST /mcp-catalog/install/cancel` answers `data: {}`.
#[derive(Serialize, JsonSchema)]
struct EmptyObject {}

/// `POST /server/config` answers the apply result, or `200` with the
/// per-field validation verdict.
#[derive(Serialize, JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum ServerConfigApply {
    Applied(SetupApplyResponse),
    Invalid(ServerConfigFieldErrors),
}

const IMAGES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
/// The distinct content types of [`crate::media_bytes::MEDIA_TYPES`], the only
/// files `/fs/raw` serves.
pub(super) const MEDIA: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/avif",
    "image/x-icon",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "application/pdf",
];
const ANY_CONTENT: &[&str] = &["*/*"];

/// The project's MCP registry file: a JSON array of server entries.
type McpRegistryFile = Vec<serde_json::Value>;

pub static ROUTES: &[ApiRoute] = &[
    // Host
    ApiRoute::get("/health", Tag::Host, "Liveness and host capabilities").bare::<HealthBody>(),
    ApiRoute::get("/openapi.json", Tag::Host, "This OpenAPI description")
        .bare::<serde_json::Map<String, serde_json::Value>>()
        .describe("The OpenAPI 3.1 document for the host's version, as JSON."),
    ApiRoute::get("/host/agent-idle-window", Tag::Host, "Idle window before an agent chat is reaped")
        .ipc::<AgentIdleWindowStatus>(),
    ApiRoute::post("/host/agent-idle-window", Tag::Host, "Override the agent idle window")
        .json::<SetAgentIdleWindowRequest>()
        .ipc::<AgentIdleWindowStatus>()
        .describe("`secs: null` clears the override. `0` is refused with `INVALID_IDLE_WINDOW`."),
    ApiRoute::get("/host/browser-policy/app", Tag::BrowserPolicy, "App-wide browser policy")
        .ipc::<AppPolicyView>(),
    ApiRoute::post("/host/browser-policy/app", Tag::BrowserPolicy, "Change the app-wide browser policy")
        .json::<ApplyAppBody>()
        .ipc::<AppPolicyView>()
        .describe("A stale `expectedRevision` is refused with `revision_conflict`."),
    ApiRoute::get("/host/browser-policy/project", Tag::BrowserPolicy, "A project's browser policy")
        .query::<browser_policy::ProjectQuery>()
        .ipc::<ProjectPolicyView>(),
    ApiRoute::post("/host/browser-policy/project", Tag::BrowserPolicy, "Change a project's browser policy")
        .json::<ApplyProjectBody>()
        .ipc::<ProjectPolicyView>()
        .describe("A stale `expectedRevision` is refused with `revision_conflict`."),
    // Realtime
    ApiRoute::get("/ws", Tag::Realtime, "Event and request WebSocket")
        .reply(Reply::Upgrade)
        .describe("Authenticates inside the protocol after the upgrade. The message protocol is out of scope for this spec."),
    ApiRoute::get("/terminal/ws", Tag::Realtime, "Terminal I/O WebSocket")
        .reply(Reply::Upgrade)
        .describe("Authenticates inside the protocol after the upgrade. The message protocol is out of scope for this spec."),
    // Projects
    ApiRoute::get("/projects", Tag::Projects, "List projects").ipc::<ProjectListPayload>(),
    ApiRoute::post("/projects", Tag::Projects, "Add a project")
        .json::<UpsertProjectRequest>()
        .ipc::<ProjectSummary>(),
    ApiRoute::post("/projects/default", Tag::Projects, "Set the host's default project")
        .json::<SetDefaultProjectRequest>(),
    ApiRoute::put("/projects/{projectId}", Tag::Projects, "Update, archive or restore a project")
        .json::<UpdateProjectRequest>()
        .describe("Refused with `PROJECT_BUSY` while sessions or terminals are bound, unless `cascade` is set."),
    ApiRoute::delete("/projects/{projectId}", Tag::Projects, "Remove a project")
        .query::<RemoveProjectQuery>()
        .describe("Refused with `PROJECT_BUSY` while sessions or terminals are bound, unless `cascade` is set."),
    ApiRoute::post("/project/icon", Tag::Projects, "Resolve a project's icon")
        .json::<ProjectIconRequest>()
        .ipc::<Option<ProjectIcon>>(),
    // Files
    ApiRoute::post("/fs/mkdir", Tag::Fs, "Create a directory").json::<MkdirRequest>(),
    ApiRoute::post("/fs/write", Tag::Fs, "Write a text file")
        .json::<WriteRequest>()
        .describe("`expected` refuses the write with `PRECONDITION_FAILED` when the file changed since it was read."),
    ApiRoute::get("/fs/ls", Tag::Fs, "List a directory")
        .query::<PathQuery>()
        .ipc::<Vec<DirectoryEntryDto>>(),
    ApiRoute::get("/fs/browse", Tag::Fs, "Browse directories for a folder picker")
        .query::<PathQuery>()
        .ipc::<Vec<DirectoryEntryDto>>(),
    ApiRoute::get("/fs/read", Tag::Fs, "Read a text file")
        .query::<PathQuery>()
        .ipc::<FileContentDto>(),
    ApiRoute::get("/fs/raw", Tag::Fs, "Read a media file's raw bytes")
        .query::<PathQuery>()
        .reply(Reply::Bytes(MEDIA)),
    ApiRoute::get("/fs/info", Tag::Fs, "File metadata")
        .query::<PathQuery>()
        .ipc::<FileInfoDto>(),
    ApiRoute::post("/fs/delete", Tag::Fs, "Delete a file or directory").json::<DeleteRequest>(),
    ApiRoute::post("/fs/rename", Tag::Fs, "Rename or move a file").json::<RenameRequest>(),
    ApiRoute::post("/fs/copy", Tag::Fs, "Copy a file or directory").json::<CopyRequest>(),
    ApiRoute::get("/shells", Tag::Fs, "Shells available on the host").ipc::<DetectedShells>(),
    // Git
    ApiRoute::post("/git/init", Tag::Git, "Initialize a repository").json::<GitInitRequest>(),
    ApiRoute::post("/git/status", Tag::Git, "Working-tree status")
        .json::<GitCwdRequest>()
        .ipc::<Vec<GitStatusDetail>>(),
    ApiRoute::post("/git/diff", Tag::Git, "Diff of one file")
        .json::<GitDiffRequest>()
        .ipc::<String>(),
    ApiRoute::post("/git/stage", Tag::Git, "Stage a file").json::<GitPathRequest>(),
    ApiRoute::post("/git/unstage", Tag::Git, "Unstage a file").json::<GitPathRequest>(),
    ApiRoute::post("/git/stage-hunk", Tag::Git, "Stage one hunk").json::<GitHunkRequest>(),
    ApiRoute::post("/git/unstage-hunk", Tag::Git, "Unstage one hunk").json::<GitHunkRequest>(),
    ApiRoute::post("/git/discard", Tag::Git, "Discard a file's changes").json::<GitPathRequest>(),
    ApiRoute::post("/git/log", Tag::Git, "Commit history")
        .json::<GitLogRequest>()
        .ipc::<Vec<GitCommit>>(),
    ApiRoute::post("/git/commit-detail", Tag::Git, "One commit's metadata and files")
        .json::<GitCommitDetailRequest>()
        .ipc::<GitCommitDetail>(),
    ApiRoute::post("/git/commit-file-diff", Tag::Git, "Diff of one file in a commit")
        .json::<GitCommitFileDiffRequest>()
        .ipc::<GitCommitFileDiff>(),
    ApiRoute::post("/git/commit", Tag::Git, "Commit staged changes")
        .json::<GitCommitRequest>()
        .describe("`expectedHead` refuses the commit with `PRECONDITION_FAILED` when `HEAD` moved."),
    ApiRoute::post("/git/push", Tag::Git, "Push the current branch").json::<GitCwdRequest>(),
    ApiRoute::post("/git/commit-context", Tag::Git, "Context for drafting a commit message")
        .json::<GitCwdRequest>()
        .ipc::<GitCommitContext>(),
    ApiRoute::post("/git/checkout-branch", Tag::Git, "Check out a branch")
        .json::<GitCheckoutBranchRequest>(),
    ApiRoute::post("/git/create-branch", Tag::Git, "Create and check out a branch")
        .json::<GitCreateBranchRequest>(),
    ApiRoute::post("/git/stash-save", Tag::Git, "Stash changes").json::<GitStashSaveRequest>(),
    ApiRoute::get("/git/stash-list", Tag::Git, "List stashes")
        .query::<GitCwdQuery>()
        .ipc::<Vec<GitStashInfoDto>>(),
    ApiRoute::post("/git/stash-apply", Tag::Git, "Apply a stash").json::<GitStashIndexRequest>(),
    ApiRoute::post("/git/stash-pop", Tag::Git, "Apply and drop a stash").json::<GitStashIndexRequest>(),
    ApiRoute::post("/git/stash-drop", Tag::Git, "Drop a stash").json::<GitStashIndexRequest>(),
    ApiRoute::get("/git/branch-list", Tag::Git, "List local branches")
        .query::<GitCwdQuery>()
        .ipc::<Vec<String>>(),
    ApiRoute::post("/git/branch-switch", Tag::Git, "Switch branch").json::<GitBranchNameRequest>(),
    ApiRoute::post("/git/diff-stat", Tag::Git, "Added and removed line counts")
        .json::<GitCwdRequest>()
        .ipc::<GitDiffStat>(),
    // GitHub
    ApiRoute::post("/github/context", Tag::Github, "Repository and `gh` CLI state")
        .json::<GithubContextRequest>()
        .ipc::<GithubContext>(),
    ApiRoute::post("/github/items", Tag::Github, "List issues or pull requests")
        .json::<GithubListRequest>()
        .ipc::<GithubListResult>(),
    ApiRoute::post("/github/item", Tag::Github, "One issue or pull request")
        .json::<GithubItemRequest>()
        .ipc::<GithubItemDetail>(),
    ApiRoute::post("/github/checks", Tag::Github, "A pull request's checks")
        .json::<GithubChecksRequest>()
        .ipc::<GithubChecksResult>(),
    ApiRoute::post("/github/check-log", Tag::Github, "One check's log")
        .json::<GithubCheckLogRequest>()
        .ipc::<GithubCheckLog>(),
    ApiRoute::post("/github/merge", Tag::Github, "Merge a pull request")
        .json::<GithubMergeRequest>()
        .ipc::<GithubMergeResult>(),
    ApiRoute::post("/github/comment", Tag::Github, "Comment on an issue or pull request")
        .json::<GithubCommentRequest>()
        .ipc::<GithubCommentResult>(),
    ApiRoute::post("/github/checkout-pr", Tag::Github, "Check out a pull request locally")
        .json::<GithubCheckoutPrRequest>()
        .ipc::<GithubCheckoutPrResult>(),
    // Worktrees
    ApiRoute::post("/worktree/list", Tag::Worktrees, "List a project's worktrees")
        .json::<WorktreeProjectPathRequest>()
        .ipc::<Vec<WebWorktreeEntry>>(),
    ApiRoute::post("/worktree/create", Tag::Worktrees, "Create a worktree")
        .json::<WorktreeCreateRequest>()
        .ipc::<GitWorktreeEntry>()
        .describe("With `streamProgress: true` the reply is `application/x-ndjson` instead: a `{\"type\":\"preparing\",\"progressId\"}` line, one `{\"type\":\"progress\",\"progressId\",\"line\"}` line per git output line, and last `{\"type\":\"result\",\"result\":<envelope>}`."),
    ApiRoute::post("/worktree/remove", Tag::Worktrees, "Remove a worktree").json::<WorktreeRemoveRequest>(),
    ApiRoute::get("/worktree/branches", Tag::Worktrees, "Branches to base a worktree on")
        .query::<WorktreeProjectPathQuery>()
        .ipc::<Vec<BranchEntry>>(),
    ApiRoute::get("/worktree/check-dirty", Tag::Worktrees, "Uncommitted changes in a worktree")
        .query::<WorktreePathQuery>()
        .ipc::<DirtyStatus>(),
    ApiRoute::post("/worktree/resolve-base-branch", Tag::Worktrees, "The project's base branch")
        .json::<WorktreeProjectPathRequest>()
        .ipc::<BaseBranchInfo>(),
    ApiRoute::post("/worktree/copy-include-files", Tag::Worktrees, "Copy `.worktree-include` files into a worktree")
        .json::<WorktreeCopyIncludeRequest>()
        .ipc::<IncludeCopyResult>(),
    ApiRoute::post("/worktree/rename-branch", Tag::Worktrees, "Rename a worktree's branch")
        .json::<WorktreeRenameBranchRequest>(),
    ApiRoute::post("/worktree/parse-gitignore", Tag::Worktrees, "Ignored directories worth symlinking")
        .json::<WorktreeProjectPathRequest>()
        .ipc::<Vec<GitignoreDir>>(),
    ApiRoute::post("/worktree/create-symlinks", Tag::Worktrees, "Symlink directories into a worktree")
        .json::<WorktreeSymlinksRequest>()
        .ipc::<Vec<SymlinkResult>>(),
    ApiRoute::post("/worktree/ensure-symlinks", Tag::Worktrees, "Recreate missing symlinks in a worktree")
        .json::<WorktreeSymlinksRequest>()
        .ipc::<Vec<SymlinkResult>>(),
    // Search
    ApiRoute::get("/search/rg-info", Tag::Search, "The host's ripgrep").ipc::<RgInfoResponse>(),
    ApiRoute::post("/search/content", Tag::Search, "Search file contents")
        .json::<SearchContentRequest>()
        .ipc::<FileSearchResponse>(),
    ApiRoute::get("/search/file-names", Tag::Search, "Search file names")
        .query::<SearchFileNamesQuery>()
        .ipc::<FileNameSearchResponse>(),
    ApiRoute::post("/search/cancel", Tag::Search, "Cancel a content search")
        .json::<SearchContentCancelRequest>(),
    // Skills
    ApiRoute::get("/skills", Tag::Skills, "List skills")
        .query::<SkillsQuery>()
        .ipc::<Vec<AgentSkillSummary>>(),
    ApiRoute::get("/skills/{name}", Tag::Skills, "Read one skill")
        .query::<SkillsQuery>()
        .ipc::<AgentSkillContent>(),
    ApiRoute::get("/skills-index", Tag::Skills, "Paths of every SKILL.md")
        .query::<SkillsQuery>()
        .ipc::<Vec<SkillFileEntry>>(),
    // Agents
    ApiRoute::get("/acp/catalog", Tag::Acp, "The agent catalog")
        .query::<CatalogQuery>()
        .ipc::<AcpCatalog>(),
    ApiRoute::post("/acp/catalog/opt-in", Tag::Acp, "Opt in to the remote agent catalog")
        .json::<SetCatalogOptInRequest>(),
    ApiRoute::post("/acp/install", Tag::Acp, "Install an agent from the catalog")
        .json::<InstallRequest>()
        .ipc::<InstallOutcome>(),
    ApiRoute::get("/acp/factory-key", Tag::Acp, "Whether a Factory API key is stored")
        .bare::<FactoryKeyStatus>()
        .errors(&[("403", "The host has no auth token configured.")])
        .describe("Needs a verified bearer token even on loopback."),
    ApiRoute::post("/acp/factory-key", Tag::Acp, "Store the Factory API key")
        .json::<FactoryKeySave>()
        .bare::<FactoryKeyStatus>()
        .errors(&[
            ("400", "The body is not a valid request, or the key failed validation."),
            ("403", "The host has no auth token configured, or the peer may not write (`code` says why)."),
        ])
        .describe("Needs a verified bearer token even on loopback."),
    // MCP servers
    ApiRoute::get("/mcp-servers", Tag::McpServers, "Read a project's MCP registry")
        .query::<McpProjectQuery>()
        .ipc::<McpRegistryFile>()
        .describe("`data` is the project's MCP registry file, `[]` when it does not exist."),
    ApiRoute::put("/mcp-servers", Tag::McpServers, "Replace a project's MCP registry")
        .query::<McpProjectQuery>()
        .json::<McpRegistryFile>()
        .describe("The body is the whole registry file (at most 1 MiB). Anything but a JSON array is refused with `MCP_REGISTRY_INVALID`."),
    ApiRoute::post("/mcp-servers/probe", Tag::McpServers, "Connect to an MCP server and list its tools")
        .json::<McpServerConfig>()
        .ipc::<ProbeResult>(),
    ApiRoute::post("/mcp-servers/oauth/start", Tag::McpServers, "Start an MCP OAuth flow")
        .json::<OAuthStartRequest>()
        .ipc::<OAuthStartResponse>(),
    ApiRoute::post("/mcp-servers/oauth/status", Tag::McpServers, "MCP OAuth connection status")
        .json::<OAuthStatusRequest>()
        .ipc::<OAuthStatusResponse>(),
    ApiRoute::post("/mcp-servers/oauth/disconnect", Tag::McpServers, "Forget an MCP OAuth token")
        .json::<OAuthStatusRequest>(),
    ApiRoute::get("/oauth/callback", Tag::McpServers, "OAuth redirect target")
        .query::<OAuthCallbackQuery>()
        .reply(Reply::Redirect)
        .describe("The authorization server redirects the browser here; clients do not call it."),
    // MCP catalog
    ApiRoute::get("/mcp-catalog/search", Tag::McpCatalog, "Search the MCP registry")
        .query::<McpCatalogSearchRequest>()
        .ipc::<McpCatalogPage>(),
    ApiRoute::post("/mcp-catalog/install/form", Tag::McpCatalog, "The install form for a catalog server")
        .json::<FormRequest>()
        .ipc::<FormReply>(),
    ApiRoute::post("/mcp-catalog/install/plan", Tag::McpCatalog, "Plan an install from the filled form")
        .json::<WithClient<PlanRequest>>()
        .ipc::<PlanReply>(),
    ApiRoute::post("/mcp-catalog/install/commit", Tag::McpCatalog, "Commit a planned install")
        .json::<WithClient<CommitRequest>>()
        .ipc::<CommitResult>(),
    ApiRoute::post("/mcp-catalog/install/cancel", Tag::McpCatalog, "Cancel a planned install")
        .json::<WithClient<CancelRequest>>()
        .ipc::<EmptyObject>(),
    ApiRoute::get("/mcp-catalog/status", Tag::McpCatalog, "Registry sync status").ipc::<McpCatalogStatus>(),
    ApiRoute::post("/mcp-catalog/sync", Tag::McpCatalog, "Turn registry sync on or off")
        .json::<SetMcpCatalogSyncRequest>()
        .ipc::<McpCatalogStatus>(),
    ApiRoute::get("/mcp-catalog/icon/{*name}", Tag::McpCatalog, "A catalog server's cached icon")
        .reply(Reply::Bytes(IMAGES)),
    // Automations
    ApiRoute::get("/api/automations", Tag::Automations, "List a project's automations")
        .query::<automation::ProjectQuery>()
        .ipc::<Vec<Automation>>(),
    ApiRoute::post("/api/automations", Tag::Automations, "Create an automation")
        .json::<automation::CreateBody>()
        .ipc::<Automation>(),
    ApiRoute::post("/api/automations/preview-schedule", Tag::Automations, "Preview a schedule's next runs")
        .json::<automation::PreviewBody>()
        .ipc::<SchedulePreview>(),
    ApiRoute::get("/api/automations/{id}", Tag::Automations, "One automation with its graph")
        .ipc::<AutomationDetail>(),
    ApiRoute::delete("/api/automations/{id}", Tag::Automations, "Delete an automation"),
    ApiRoute::post("/api/automations/{id}/ops", Tag::Automations, "Edit an automation's graph")
        .json::<automation::OpsBody>()
        .ipc::<ApplyOpsResult>()
        .describe("A stale `base_revision` is refused with `revision_conflict` (409) and `current_revision`."),
    ApiRoute::post("/api/automations/{id}/enabled", Tag::Automations, "Enable or disable an automation")
        .json::<automation::EnabledBody>()
        .ipc::<Automation>(),
    ApiRoute::post("/api/automations/{id}/approve", Tag::Automations, "Approve a revision to run")
        .json::<automation::ApproveBody>()
        .ipc::<Automation>(),
    ApiRoute::post("/api/automations/{id}/run", Tag::Automations, "Run an automation now")
        .ipc::<Run>()
        .describe("Runs the approved revision. An unapproved current revision is refused with `not_approved` (409)."),
    ApiRoute::get("/api/automations/{id}/runs", Tag::Automations, "An automation's recent runs")
        .query::<automation::RunsQuery>()
        .ipc::<Vec<Run>>(),
    ApiRoute::post("/api/automations/{id}/seen", Tag::Automations, "Mark an automation's runs seen"),
    ApiRoute::post("/api/automation-runs/{run_id}/cancel", Tag::Automations, "Cancel a run")
        .ipc::<bool>(),
    ApiRoute::get("/api/automation-runs/{run_id}/steps", Tag::Automations, "A run's steps")
        .ipc::<Vec<Step>>(),
    ApiRoute::get("/api/automation-agents", Tag::Automations, "Agents an automation can use")
        .ipc::<Vec<KnownAgent>>(),
    ApiRoute::get("/api/automation-secrets", Tag::Automations, "Names of a project's automation secrets")
        .query::<automation::ProjectQuery>()
        .ipc::<Vec<String>>(),
    ApiRoute::put("/api/automation-secrets", Tag::Automations, "Store an automation secret")
        .json::<automation::SecretBody>(),
    ApiRoute::delete("/api/automation-secrets", Tag::Automations, "Delete an automation secret")
        .query::<automation::SecretQuery>(),
    ApiRoute::get("/api/automation-suggestions", Tag::Automations, "Suggested automations for a project")
        .query::<automation::SuggestionsQuery>()
        .ipc::<Vec<Suggestion>>(),
    ApiRoute::post("/api/automation-suggestions/match", Tag::Automations, "Match free text to a suggestion")
        .json::<automation::MatchBody>()
        .ipc::<Option<Suggestion>>(),
    ApiRoute::post("/api/automation-suggestions/dismiss", Tag::Automations, "Dismiss a suggestion")
        .json::<automation::SuggestionBody>(),
    ApiRoute::post("/api/automation-suggestions/accept", Tag::Automations, "Accept a suggestion")
        .json::<automation::SuggestionBody>(),
    // Canvas
    ApiRoute::post("/canvas/open", Tag::Canvas, "Open a canvas document")
        .json::<CanvasOpenRequest>()
        .ipc::<CanvasOpenInfo>(),
    ApiRoute::post("/canvas/close", Tag::Canvas, "Close a canvas")
        .json::<CanvasCloseRequest>()
        .ipc::<CloseOutcome>(),
    ApiRoute::post("/canvas/read-document", Tag::Canvas, "Read the document a canvas mounts")
        .json::<canvas::MountRequest>()
        .ipc::<DocumentBytes>(),
    ApiRoute::post("/canvas/document-loaded", Tag::Canvas, "Report that the editor loaded the document")
        .json::<canvas::LoadedRequest>()
        .ipc::<PersistenceView>(),
    ApiRoute::post("/canvas/dirty-changed", Tag::Canvas, "Report unsaved-changes state")
        .json::<canvas::DirtyRequest>()
        .ipc::<DirtyOutcome>(),
    ApiRoute::post("/canvas/set-visible", Tag::Canvas, "Report canvas visibility")
        .json::<canvas::VisibleRequest>(),
    ApiRoute::post("/canvas/write-snapshot", Tag::Canvas, "Save a document snapshot")
        .json::<canvas::SnapshotRequest>()
        .ipc::<WriteOutcome>(),
    ApiRoute::post("/canvas/disk-changed", Tag::Canvas, "Report that the file changed on disk")
        .json::<canvas::DiskRequest>()
        .ipc::<DiskOutcome>(),
    ApiRoute::post("/canvas/resolve-conflict", Tag::Canvas, "Resolve a disk/editor conflict")
        .json::<canvas::ResolveRequest>()
        .ipc::<ResolveOutcome>(),
    ApiRoute::post("/canvas/crashed", Tag::Canvas, "Report an editor crash and remount")
        .json::<canvas::CrashedRequest>()
        .ipc::<Remount>(),
    ApiRoute::get("/canvas/{id}", Tag::Canvas, "Canvas bundle without a token")
        .reply(Reply::Refused)
        .describe("Always answers 401: the bundle lives under `/canvas/{id}/{token}/`."),
    ApiRoute::get("/canvas/{id}/", Tag::Canvas, "Canvas bundle without a token")
        .reply(Reply::Refused)
        .describe("Always answers 401: the bundle lives under `/canvas/{id}/{token}/`."),
    ApiRoute::get("/canvas/{id}/{*rest}", Tag::Canvas, "The canvas editor bundle")
        .reply(Reply::Bytes(ANY_CONTENT))
        .describe("`rest` starts with the canvas session token from `POST /canvas/open`, which authorizes the request instead of the bearer token: a missing or wrong token answers 401, and the bare token without a trailing `/` answers 308 to the slashed form. Only `GET` and `HEAD` are served."),
    // Diagnostics
    ApiRoute::post("/log/frontend-error", Tag::Diagnostics, "Forward a frontend error to the host log")
        .json::<FrontendErrorRequest>(),
    ApiRoute::post("/log/diagnostics", Tag::Diagnostics, "Collect bug-report context")
        .ipc::<BugReportContext>(),
    ApiRoute::post("/log/report-bug", Tag::Diagnostics, "File a bug report through the host's `gh`")
        .json::<BugReportSubmitRequest>()
        .ipc::<BugReportSubmitResult>(),
    // Server admin
    ApiRoute::get("/server/config", Tag::ServerAdmin, "The running server's configuration")
        .ipc::<ServerConfigResponse>()
        .describe("Standalone `termul-server` only."),
    ApiRoute::post("/server/config", Tag::ServerAdmin, "Reconfigure and restart the server")
        .json::<ServerSetupAnswers>()
        .ipc::<ServerConfigApply>()
        .describe("Standalone `termul-server` only. Invalid answers come back as `ok: false` with `fieldErrors`. On success the server restarts: reconnect to `host:port` with `webAuthToken`. A host without a token needs a loopback `Origin` header (`403 SERVER_CONFIG_LOCAL_ORIGIN_REQUIRED`). A second apply while a restart is pending answers `409 SERVER_CONFIG_APPLY_IN_PROGRESS`."),
];

