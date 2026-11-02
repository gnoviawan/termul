//! Repository labels and assignable users for the pickers, and the writes
//! that change an item's labels, assignees and open/closed state. Requests
//! name labels and people; ids are resolved here from a fresh read, and
//! mutation variables travel on stdin.

use serde::Deserialize;

use super::comment;
use super::error::GithubError;
use super::graphql::{Nodes, RATE_LIMIT_FIELDS};
use super::types::{
    GithubCloseReason, GithubCreateLabelRequest, GithubEditItemRequest, GithubItemKind,
    GithubItemStateAction, GithubRepoLabel, GithubRepoMeta, GithubRepoRef,
};

/// GitHub's limits on a label's name and description.
const MAX_LABEL_NAME_CHARS: usize = 50;
const MAX_LABEL_DESCRIPTION_CHARS: usize = 100;

const META_FIELDS: &str =
    "labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { id name color description } } \
     assignableUsers(first: 100) { nodes { id login } }";
const CURRENT_FIELDS: &str =
    "id labels(first: 100) { nodes { id name } } assignees(first: 100) { nodes { id login } }";

pub(super) fn repo_meta_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!) {{ {RATE_LIMIT_FIELDS} viewer {{ id login }} \
         repository(owner: $owner, name: $name) {{ {META_FIELDS} }} }}"
    )
}

/// The repository's labels and people plus the item's current ones, so an
/// edit resolves every name from one read.
pub(super) fn edit_target_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         viewer {{ id login }} repository(owner: $owner, name: $name) {{ {META_FIELDS} \
         issueOrPullRequest(number: $number) {{ __typename \
         ... on Issue {{ {CURRENT_FIELDS} }} ... on PullRequest {{ {CURRENT_FIELDS} }} }} }} }}"
    )
}

#[derive(Deserialize)]
struct LabelNode {
    id: String,
    name: String,
    #[serde(default)]
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct UserNode {
    id: String,
    login: String,
}

#[derive(Deserialize)]
struct CurrentNode {
    labels: Option<Nodes<LabelNode>>,
    assignees: Option<Nodes<UserNode>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaRepo {
    labels: Nodes<LabelNode>,
    assignable_users: Nodes<UserNode>,
    #[serde(default)]
    issue_or_pull_request: Option<CurrentNode>,
}

#[derive(Deserialize)]
struct MetaData {
    viewer: UserNode,
    repository: Option<MetaRepo>,
}

fn parse_meta(data: &serde_json::Value) -> Result<MetaData, GithubError> {
    let meta: MetaData = serde_json::from_value(data.clone())
        .map_err(|e| GithubError::Failed(format!("unreadable repository labels: {e}")))?;
    if meta.repository.is_none() {
        return Err(GithubError::NotFound("repository".to_string()));
    }
    Ok(meta)
}

pub(super) fn parse_repo_meta(
    data: &serde_json::Value,
    repo: &GithubRepoRef,
    fetched_at: String,
) -> Result<GithubRepoMeta, GithubError> {
    let meta = parse_meta(data)?;
    let repository = meta.repository.expect("checked by parse_meta");
    Ok(GithubRepoMeta {
        repo: repo.clone(),
        labels: repository
            .labels
            .iter()
            .map(|label| GithubRepoLabel {
                name: label.name.clone(),
                color: label.color.clone(),
                description: label.description.clone().filter(|d| !d.is_empty()),
            })
            .collect(),
        assignable_users: repository
            .assignable_users
            .iter()
            .map(|user| user.login.clone())
            .collect(),
        viewer: meta.viewer.login,
        fetched_at,
    })
}

/// The label to create, trimmed and checked against GitHub's limits.
pub(super) fn checked_label(
    request: &GithubCreateLabelRequest,
) -> Result<GithubRepoLabel, GithubError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(GithubError::Refused("The label name is empty".to_string()));
    }
    if name.chars().count() > MAX_LABEL_NAME_CHARS {
        return Err(GithubError::Refused(format!(
            "A label name has at most {MAX_LABEL_NAME_CHARS} characters"
        )));
    }
    let color = request.color.trim().trim_start_matches('#');
    if color.len() != 6 || !color.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GithubError::Refused(format!(
            "\"{color}\" is not a six-digit hex colour"
        )));
    }
    let description = request
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    if description.is_some_and(|d| d.chars().count() > MAX_LABEL_DESCRIPTION_CHARS) {
        return Err(GithubError::Refused(format!(
            "A label description has at most {MAX_LABEL_DESCRIPTION_CHARS} characters"
        )));
    }
    Ok(GithubRepoLabel {
        name: name.to_string(),
        color: color.to_ascii_lowercase(),
        description: description.map(str::to_string),
    })
}

/// `gh label create` argv. Values ride in `--flag=value` and the name after
/// `--`, so text starting with `-` is never read as a flag.
pub(super) fn create_label_args(repo: &GithubRepoRef, label: &GithubRepoLabel) -> Vec<String> {
    let mut args = vec![
        "label".to_string(),
        "create".to_string(),
        format!("--repo={}", repo.qualified()),
        format!("--color={}", label.color),
    ];
    if let Some(description) = &label.description {
        args.push(format!("--description={description}"));
    }
    args.extend(["--".to_string(), label.name.clone()]);
    args
}

pub(super) fn is_empty_edit(request: &GithubEditItemRequest) -> bool {
    request.add_labels.is_empty()
        && request.remove_labels.is_empty()
        && request.add_assignees.is_empty()
        && request.remove_assignees.is_empty()
}

/// Ids of `names`, matched without case like GitHub does.
fn resolve(
    names: &[String],
    known: &[(&str, &str)],
    what: &str,
) -> Result<Vec<String>, GithubError> {
    names
        .iter()
        .map(|name| {
            known
                .iter()
                .find(|(known, _)| known.eq_ignore_ascii_case(name.trim()))
                .map(|(_, id)| id.to_string())
                .ok_or_else(|| {
                    GithubError::Refused(format!("{what} \"{name}\" is not in this repository"))
                })
        })
        .collect()
}

/// The mutation and variables applying `request`, given `data` from
/// [`edit_target_graphql`]. A name GitHub does not know is refused.
pub(super) fn edit_mutation(
    data: &serde_json::Value,
    request: &GithubEditItemRequest,
) -> Result<(String, serde_json::Value), GithubError> {
    let item_id = comment::parse_subject(data, request.kind, request.number)?;
    let meta = parse_meta(data)?;
    let repository = meta.repository.as_ref().expect("checked by parse_meta");
    let current = repository.issue_or_pull_request.as_ref();
    let current_labels = current.and_then(|c| c.labels.as_ref());
    let current_people = current.and_then(|c| c.assignees.as_ref());
    // The item's own labels and assignees resolve even past the repository's first 100.
    let labels: Vec<(&str, &str)> = current_labels
        .into_iter()
        .flat_map(Nodes::iter)
        .chain(repository.labels.iter())
        .map(|l| (l.name.as_str(), l.id.as_str()))
        .collect();
    let people: Vec<(&str, &str)> = current_people
        .into_iter()
        .flat_map(Nodes::iter)
        .chain(std::iter::once(&meta.viewer))
        .chain(repository.assignable_users.iter())
        .map(|u| (u.login.as_str(), u.id.as_str()))
        .collect();
    let changes = [
        (
            "addLabels",
            resolve(&request.add_labels, &labels, "Label")?,
            "addLabelsToLabelable(input: { labelableId: $id, labelIds: $addLabels })",
        ),
        (
            "removeLabels",
            resolve(&request.remove_labels, &labels, "Label")?,
            "removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $removeLabels })",
        ),
        (
            "addAssignees",
            resolve(&request.add_assignees, &people, "Assignee")?,
            "addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: $addAssignees })",
        ),
        (
            "removeAssignees",
            resolve(&request.remove_assignees, &people, "Assignee")?,
            "removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: $removeAssignees })",
        ),
    ];
    let mut params = vec!["$id: ID!".to_string()];
    let mut fields = Vec::new();
    let mut variables = serde_json::Map::new();
    variables.insert("id".to_string(), item_id.into());
    for (name, ids, field) in changes {
        if ids.is_empty() {
            continue;
        }
        params.push(format!("${name}: [ID!]!"));
        fields.push(format!("{name}: {field} {{ clientMutationId }}"));
        variables.insert(name.to_string(), ids.into());
    }
    let mutation = format!("mutation({}) {{ {} }}", params.join(", "), fields.join(" "));
    Ok((mutation, serde_json::Value::Object(variables)))
}

/// The mutation and variables closing or reopening node `id`. A PR close
/// has no reason, so the request's is ignored.
pub(super) fn state_mutation(
    kind: GithubItemKind,
    action: GithubItemStateAction,
    id: &str,
) -> (String, serde_json::Value) {
    let (mutation, variables) = match (kind, action) {
        (GithubItemKind::Issue, GithubItemStateAction::Close { reason }) => (
            "mutation($id: ID!, $reason: IssueClosedStateReason!) { \
             closeIssue(input: { issueId: $id, stateReason: $reason }) { clientMutationId } }",
            serde_json::json!({
                "id": id,
                "reason": match reason {
                    GithubCloseReason::Completed => "COMPLETED",
                    GithubCloseReason::NotPlanned => "NOT_PLANNED",
                },
            }),
        ),
        (GithubItemKind::Issue, GithubItemStateAction::Reopen) => (
            "mutation($id: ID!) { reopenIssue(input: { issueId: $id }) { clientMutationId } }",
            serde_json::json!({ "id": id }),
        ),
        (GithubItemKind::Pr, GithubItemStateAction::Close { .. }) => (
            "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }",
            serde_json::json!({ "id": id }),
        ),
        (GithubItemKind::Pr, GithubItemStateAction::Reopen) => (
            "mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }",
            serde_json::json!({ "id": id }),
        ),
    };
    (mutation.to_string(), variables)
}

/// A write whose outcome is unknown: GitHub may have applied it.
pub(super) fn maybe_applied(what: &str) -> GithubError {
    GithubError::Failed(format!(
        "{what}, so the change may already be applied; reload the item before trying again"
    ))
}
