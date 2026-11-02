//! The issue/PR list (CAP-2): one GraphQL `search` per filter.

use super::error::GithubError;
use super::graphql::{ItemNode, ITEM_FIELDS, PR_ROLLUP_FIELDS, RATE_LIMIT_FIELDS};
use super::types::{
    GithubAssigneeFilter, GithubKindFilter, GithubLabelMode, GithubListFilter, GithubListItem,
    GithubRepoRef, GithubSort, GithubStateFilter,
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
/// A user login that is not a GitHub login is refused.
///
/// Search ORs repeated `is:` type qualifiers (`is:issue is:pr` matches both),
/// so exactly one type qualifier is ever emitted.
pub(super) fn search_query(
    repo: &GithubRepoRef,
    filter: &GithubListFilter,
) -> Result<Option<String>, GithubError> {
    let pr_only = filter.review_requested
        || matches!(
            filter.state,
            GithubStateFilter::Merged | GithubStateFilter::Draft
        );
    let sort = match filter.sort {
        GithubSort::Updated => "updated",
        GithubSort::Created => "created",
        GithubSort::Comments => "comments",
    };
    let mut terms = vec![
        format!("repo:{}/{}", repo.owner, repo.name),
        format!("sort:{sort}-desc"),
    ];
    match (filter.kind, pr_only) {
        (GithubKindFilter::Issue, true) => return Ok(None),
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
    terms.extend(label_terms(&filter.labels, filter.label_mode));
    match &filter.assignee {
        GithubAssigneeFilter::Anyone => {}
        GithubAssigneeFilter::Me => terms.push("assignee:@me".to_string()),
        GithubAssigneeFilter::Unassigned => terms.push("no:assignee".to_string()),
        GithubAssigneeFilter::User { login } => {
            if login.is_empty()
                || !login
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(GithubError::Refused(format!(
                    "\"{login}\" is not a GitHub login"
                )));
            }
            terms.push(format!("assignee:{login}"));
        }
    }
    if filter.review_requested {
        terms.push("review-requested:@me".to_string());
    }
    terms.extend(text_terms(&filter.search));
    Ok(Some(terms.join(" ")))
}

fn label_terms(labels: &[String], mode: GithubLabelMode) -> Vec<String> {
    let quoted: Vec<String> = labels
        .iter()
        .map(|label| label.replace('"', ""))
        .filter(|label| !label.trim().is_empty())
        .map(|label| format!("\"{label}\""))
        .collect();
    if quoted.is_empty() {
        return Vec::new();
    }
    match mode {
        GithubLabelMode::Any => vec![format!("label:{}", quoted.join(","))],
        GithubLabelMode::All => quoted.iter().map(|l| format!("label:{l}")).collect(),
        GithubLabelMode::Exclude => quoted.iter().map(|l| format!("-label:{l}")).collect(),
    }
}

/// The free text as plain words: no quotes, parentheses, `OR`/`AND`/`NOT`
/// or `name:value` qualifiers, so it never overrides the filter's own terms.
fn text_terms(search: &str) -> Vec<String> {
    search
        .replace('"', "")
        .replace(['(', ')'], " ")
        .split_whitespace()
        .filter(|word| !matches!(*word, "OR" | "AND" | "NOT") && !is_qualifier(word))
        .map(str::to_string)
        .collect()
}

fn is_qualifier(word: &str) -> bool {
    word.trim_start_matches('-')
        .split_once(':')
        .is_some_and(|(name, _)| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
        })
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
