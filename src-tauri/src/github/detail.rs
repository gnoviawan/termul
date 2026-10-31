//! One issue or PR with its body, conversation and review threads (CAP-3),
//! and the merge-state read the merge op decides on (CAP-4).

use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;

use super::error::GithubError;
use super::graphql::{
    CommentNode, ItemNode, Nodes, PageInfo, ReviewThreadNode, ITEM_FIELDS, PR_ROLLUP_FIELDS,
    RATE_LIMIT_FIELDS,
};
use super::types::{GithubItemKind, GithubMergeable, GithubPullDetail, GithubReviewThread};

pub(super) const COMMENT_FIELDS: &str = "id body createdAt url author { login }";
const PAGE_INFO: &str = "pageInfo { hasNextPage endCursor }";
/// Most conversation comments, review threads, and comments per thread one
/// detail read loads; paging past the first page stops at these.
const MAX_COMMENTS: usize = 500;
const MAX_THREADS: usize = 300;
const MAX_THREAD_COMMENTS: usize = 100;
/// Threads whose next comment page one batched query fetches.
const THREADS_PER_QUERY: usize = 25;
/// A page is not started with less time than this left in the read budget.
const MIN_PAGE_TIME: Duration = Duration::from_secs(2);

fn thread_fields() -> String {
    format!(
        "id isResolved isOutdated path line \
         comments(first: 50) {{ {PAGE_INFO} nodes {{ {COMMENT_FIELDS} }} }}"
    )
}

pub(super) fn detail_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ issueOrPullRequest(number: $number) {{ __typename \
         ... on Issue {{ {ITEM_FIELDS} body createdAt \
           comments(first: 100) {{ totalCount {PAGE_INFO} nodes {{ {COMMENT_FIELDS} }} }} }} \
         ... on PullRequest {{ {ITEM_FIELDS} body createdAt {PR_ROLLUP_FIELDS} \
           comments(first: 100) {{ totalCount {PAGE_INFO} nodes {{ {COMMENT_FIELDS} }} }} \
           headRefName headRefOid baseRefName isCrossRepository maintainerCanModify \
           mergeable mergeStateStatus autoMergeRequest {{ enabledAt }} \
           additions deletions changedFiles \
           reviewThreads(first: 100) {{ {PAGE_INFO} nodes {{ {threads} }} }} \
         }} }} }} }}",
        threads = thread_fields()
    )
}

fn comments_page_graphql() -> String {
    let page = format!(
        "comments(first: 100, after: $after) {{ {PAGE_INFO} nodes {{ {COMMENT_FIELDS} }} }}"
    );
    format!(
        "query($owner: String!, $name: String!, $number: Int!, $after: String!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ issueOrPullRequest(number: $number) {{ \
         ... on Issue {{ {page} }} ... on PullRequest {{ {page} }} }} }} }}"
    )
}

fn threads_page_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!, $after: String!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ \
         reviewThreads(first: 100, after: $after) {{ {PAGE_INFO} nodes {{ {threads} }} }} }} }} }}",
        threads = thread_fields()
    )
}

/// The next comment page of `count` threads, aliased `t0…`, cursors `$c0…`.
fn thread_comments_graphql(count: usize) -> String {
    let params: Vec<String> = (0..count)
        .map(|i| format!("$t{i}: ID!, $c{i}: String!"))
        .collect();
    let fields: String = (0..count)
        .map(|i| {
            format!(
                " t{i}: node(id: $t{i}) {{ ... on PullRequestReviewThread {{ \
                 comments(first: 50, after: $c{i}) {{ {PAGE_INFO} nodes {{ {COMMENT_FIELDS} }} }} }} }}"
            )
        })
        .collect();
    format!(
        "query({}) {{ {RATE_LIMIT_FIELDS}{fields} }}",
        params.join(", ")
    )
}

/// Runs one paging query with the time left; the service routes it to gh.
pub(super) type PageFetch<'a> =
    dyn FnMut(&str, serde_json::Value, Duration) -> Result<serde_json::Value, GithubError> + 'a;

/// Load the conversation comments, review threads and thread comments past
/// the first page into `node`, up to the caps, until `deadline`. A failed or
/// late page ends paging and keeps what loaded: the counts in the item still
/// tell the reader there is more.
pub(super) fn load_remaining_pages(
    node: &mut ItemNode,
    target: serde_json::Value,
    deadline: Instant,
    fetch: &mut PageFetch<'_>,
) {
    let mut pager = Pager { deadline, fetch };
    if let Err(error) = pager.load(node, &target) {
        log::warn!("[github] detail paging stopped early code={}", error.code());
    }
}

struct Pager<'f, 'a> {
    deadline: Instant,
    fetch: &'f mut PageFetch<'a>,
}

impl Pager<'_, '_> {
    fn load(&mut self, node: &mut ItemNode, target: &serde_json::Value) -> Result<(), GithubError> {
        if let Some(comments) = node.comments.as_mut() {
            self.drain(
                &mut comments.nodes,
                &mut comments.page_info,
                MAX_COMMENTS,
                &comments_page_graphql(),
                target,
                "/repository/issueOrPullRequest/comments",
            )?;
        }
        if let Some(threads) = node.review_threads.as_mut() {
            self.drain(
                &mut threads.nodes,
                &mut threads.page_info,
                MAX_THREADS,
                &threads_page_graphql(),
                target,
                "/repository/pullRequest/reviewThreads",
            )?;
            self.drain_thread_comments(threads)?;
        }
        Ok(())
    }

    fn call(
        &mut self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<serde_json::Value, GithubError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left < MIN_PAGE_TIME {
            return Err(GithubError::Timeout);
        }
        (self.fetch)(query, variables, left)
    }

    fn page<T: DeserializeOwned>(
        &mut self,
        query: &str,
        variables: serde_json::Value,
        pointer: &str,
    ) -> Result<Option<T>, GithubError> {
        let data = self.call(query, variables)?;
        match data.pointer(pointer).filter(|value| !value.is_null()) {
            Some(value) => serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|e| GithubError::Failed(format!("unreadable page: {e}"))),
            None => Ok(None),
        }
    }

    /// Follow `page_info` into `nodes` until there is no next page or `cap`.
    fn drain<T: DeserializeOwned>(
        &mut self,
        nodes: &mut Vec<Option<T>>,
        page_info: &mut PageInfo,
        cap: usize,
        query: &str,
        target: &serde_json::Value,
        pointer: &str,
    ) -> Result<(), GithubError> {
        while nodes.len() < cap {
            let Some(after) = page_info.next() else {
                break;
            };
            let mut variables = target.clone();
            variables["after"] = after.into();
            let Some(page) = self.page::<Nodes<T>>(query, variables, pointer)? else {
                break;
            };
            if page.nodes.is_empty() {
                break;
            }
            nodes.extend(page.nodes);
            *page_info = page.page_info;
        }
        nodes.truncate(cap);
        Ok(())
    }

    fn drain_thread_comments(
        &mut self,
        threads: &mut Nodes<ReviewThreadNode>,
    ) -> Result<(), GithubError> {
        loop {
            let pending: Vec<&mut ReviewThreadNode> = threads
                .nodes
                .iter_mut()
                .flatten()
                .filter(|thread| {
                    thread.comments.nodes.len() < MAX_THREAD_COMMENTS
                        && thread.comments.page_info.next().is_some()
                })
                .take(THREADS_PER_QUERY)
                .collect();
            if pending.is_empty() {
                return Ok(());
            }
            let mut variables = serde_json::Map::new();
            for (i, thread) in pending.iter().enumerate() {
                variables.insert(format!("t{i}"), thread.id.clone().into());
                variables.insert(
                    format!("c{i}"),
                    thread.comments.page_info.next().unwrap_or_default().into(),
                );
            }
            let data = self.call(
                &thread_comments_graphql(pending.len()),
                serde_json::Value::Object(variables),
            )?;
            for (i, thread) in pending.into_iter().enumerate() {
                let page: Option<Nodes<CommentNode>> = data
                    .pointer(&format!("/t{i}/comments"))
                    .and_then(|value| serde_json::from_value(value.clone()).ok());
                match page {
                    Some(page) => {
                        thread.comments.nodes.extend(page.nodes);
                        thread.comments.nodes.truncate(MAX_THREAD_COMMENTS);
                        thread.comments.page_info = page.page_info;
                    }
                    // A thread GitHub no longer returns stops paging.
                    None => thread.comments.page_info = Default::default(),
                }
            }
        }
    }
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
