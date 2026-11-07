//! Comments on an issue or PR conversation and replies in a PR review thread
//! (CAP-7, CAP-8, CAP-11). Bodies travel to `gh` on stdin, inside GraphQL
//! variables, never in argv or the query text.

use serde::Deserialize;

use super::detail::COMMENT_FIELDS;
use super::error::GithubError;
use super::graphql::{CommentNode, RATE_LIMIT_FIELDS};
use super::types::{
    GithubComment, GithubCommentRequest, GithubCommentTarget, GithubItemKind, GithubRepoRef,
};

/// GitHub rejects comment bodies longer than this many characters.
pub(super) const MAX_BODY_CHARS: usize = 65_536;

/// The body to send, or why the request cannot be sent.
pub(super) fn checked_body(request: &GithubCommentRequest) -> Result<&str, GithubError> {
    let body = request.body.as_str();
    if matches!(request.target, GithubCommentTarget::ReviewThread { .. })
        && request.kind != GithubItemKind::Pr
    {
        return Err(GithubError::Refused(
            "Only pull requests have review threads".to_string(),
        ));
    }
    if body.trim().is_empty() {
        return Err(GithubError::EmptyComment);
    }
    let chars = body.chars().count();
    if chars > MAX_BODY_CHARS {
        return Err(GithubError::Refused(format!(
            "The comment is {chars} characters; GitHub accepts at most {MAX_BODY_CHARS}"
        )));
    }
    Ok(body)
}

/// The node id of issue or PR `$number`, with its type.
pub(super) fn subject_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ issueOrPullRequest(number: $number) {{ \
         __typename ... on Issue {{ id }} ... on PullRequest {{ id }} }} }} }}"
    )
}

/// The PR and repository a review thread belongs to.
pub(super) fn thread_owner_graphql() -> String {
    format!(
        "query($id: ID!) {{ {RATE_LIMIT_FIELDS} node(id: $id) {{ \
         ... on PullRequestReviewThread {{ pullRequest {{ number \
         repository {{ name owner {{ login }} }} }} }} }} }}"
    )
}

pub(super) fn add_comment_graphql() -> String {
    format!(
        "mutation($subjectId: ID!, $body: String!) {{ \
         addComment(input: {{ subjectId: $subjectId, body: $body }}) {{ \
         commentEdge {{ node {{ {COMMENT_FIELDS} }} }} }} }}"
    )
}

pub(super) fn add_thread_reply_graphql() -> String {
    format!(
        "mutation($threadId: ID!, $body: String!) {{ \
         addPullRequestReviewThreadReply(input: {{ pullRequestReviewThreadId: $threadId, body: $body }}) {{ \
         comment {{ {COMMENT_FIELDS} }} }} }}"
    )
}

#[derive(Deserialize)]
struct Subject {
    #[serde(rename = "__typename")]
    typename: String,
    id: String,
}

/// The node id to comment on, when `#number` exists and is of `kind`.
pub(super) fn parse_subject(
    data: &serde_json::Value,
    kind: GithubItemKind,
    number: u64,
) -> Result<String, GithubError> {
    let subject: Subject = data
        .pointer("/repository/issueOrPullRequest")
        .filter(|node| !node.is_null())
        .and_then(|node| serde_json::from_value(node.clone()).ok())
        .ok_or_else(|| GithubError::NotFound(format!("#{number}")))?;
    let expected = match kind {
        GithubItemKind::Issue => "Issue",
        GithubItemKind::Pr => "PullRequest",
    };
    if subject.typename != expected {
        return Err(GithubError::NotFound(format!(
            "#{number} is not {}",
            match kind {
                GithubItemKind::Issue => "an issue",
                GithubItemKind::Pr => "a pull request",
            }
        )));
    }
    Ok(subject.id)
}

#[derive(Deserialize)]
struct ThreadOwner {
    #[serde(rename = "pullRequest")]
    pull_request: ThreadPull,
}

#[derive(Deserialize)]
struct ThreadPull {
    number: u64,
    repository: ThreadRepo,
}

#[derive(Deserialize)]
struct ThreadRepo {
    name: String,
    owner: super::graphql::Login,
}

/// Ok when review thread `data` belongs to PR `number` of `repo`, so a
/// request cannot reply in another repository than its cwd resolves to.
pub(super) fn check_thread_owner(
    data: &serde_json::Value,
    repo: &GithubRepoRef,
    number: u64,
) -> Result<(), GithubError> {
    let owner: ThreadOwner = data
        .get("node")
        .filter(|node| !node.is_null())
        .and_then(|node| serde_json::from_value(node.clone()).ok())
        .ok_or_else(|| GithubError::NotFound("review thread".to_string()))?;
    let pull = owner.pull_request;
    let same_repo = pull
        .repository
        .owner
        .login
        .eq_ignore_ascii_case(&repo.owner)
        && pull.repository.name.eq_ignore_ascii_case(&repo.name);
    if same_repo && pull.number == number {
        Ok(())
    } else {
        Err(GithubError::NotFound(format!(
            "review thread on pull request #{number} of {repo}"
        )))
    }
}

/// The comment a mutation created, at `pointer` in its data.
pub(super) fn parse_created(
    data: &serde_json::Value,
    pointer: &str,
) -> Result<GithubComment, GithubError> {
    data.pointer(pointer)
        .filter(|node| !node.is_null())
        .and_then(|node| serde_json::from_value::<CommentNode>(node.clone()).ok())
        .map(|node| node.to_comment())
        .ok_or_else(|| maybe_posted("GitHub did not return the created comment"))
}

/// A write whose outcome is unknown: resending it could post the comment twice.
pub(super) fn maybe_posted(what: &str) -> GithubError {
    GithubError::Failed(format!(
        "{what}, so the comment may already be posted; check the conversation before sending it again"
    ))
}
