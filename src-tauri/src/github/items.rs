//! The issue/PR list (CAP-2): one GraphQL `search` per filter.

use super::graphql::{ItemNode, ITEM_FIELDS, PR_ROLLUP_FIELDS, RATE_LIMIT_FIELDS};
use super::types::{
    GithubKindFilter, GithubListFilter, GithubListItem, GithubRepoRef, GithubStateFilter,
};

pub(super) const PAGE_SIZE: u64 = 50;

pub(super) fn search_graphql() -> String {
    format!(
        "query($q: String!) {{ {RATE_LIMIT_FIELDS} \
         search(type: ISSUE, first: {PAGE_SIZE}, query: $q) {{ nodes {{ __typename \
         ... on Issue {{ {ITEM_FIELDS} comments {{ totalCount }} }} \
         ... on PullRequest {{ {ITEM_FIELDS} comments {{ totalCount }} {PR_ROLLUP_FIELDS} }} \
         }} }} }}"
    )
}

/// The GitHub search string for `filter`, or `None` when the filter cannot
/// match anything (issues filtered by a PR-only state or review request).
///
/// Search ORs repeated `is:` type qualifiers (`is:issue is:pr` matches both),
/// so exactly one type qualifier is ever emitted.
pub(super) fn search_query(repo: &GithubRepoRef, filter: &GithubListFilter) -> Option<String> {
    let pr_only = filter.review_requested
        || matches!(
            filter.state,
            GithubStateFilter::Merged | GithubStateFilter::Draft
        );
    let mut terms = vec![
        format!("repo:{}/{}", repo.owner, repo.name),
        "sort:updated-desc".to_string(),
    ];
    match (filter.kind, pr_only) {
        (GithubKindFilter::Issue, true) => return None,
        (GithubKindFilter::Issue, false) => terms.push("is:issue".to_string()),
        (GithubKindFilter::Pr, _) | (GithubKindFilter::All, true) => {
            terms.push("is:pr".to_string())
        }
        (GithubKindFilter::All, false) => {}
    }
    match filter.state {
        GithubStateFilter::All => {}
        GithubStateFilter::Open => terms.push("is:open".to_string()),
        // Merged PRs are their own state, so "closed" leaves them out.
        GithubStateFilter::Closed => {
            terms.extend(["is:closed".to_string(), "-is:merged".to_string()])
        }
        GithubStateFilter::Merged => terms.push("is:merged".to_string()),
        GithubStateFilter::Draft => terms.extend(["is:open".to_string(), "draft:true".to_string()]),
    }
    if filter.assigned_to_me {
        terms.push("assignee:@me".to_string());
    }
    if filter.review_requested {
        terms.push("review-requested:@me".to_string());
    }
    Some(terms.join(" "))
}

/// Items from a search response's `data`; nodes of other types are skipped.
pub(super) fn parse_search(data: &serde_json::Value) -> Vec<GithubListItem> {
    data.pointer("/search/nodes")
        .and_then(serde_json::Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| serde_json::from_value::<ItemNode>(node.clone()).ok())
                .filter_map(|node| node.list_item())
                .collect()
        })
        .unwrap_or_default()
}
