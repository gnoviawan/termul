use super::fake_gh::{fail, fake_gh_with_stdin, has, ok, service_with, Project, Reply, AUTH};
use super::types::*;
use super::GithubError;

const ISSUE_SUBJECT: &str =
    r#"{"data":{"repository":{"issueOrPullRequest":{"__typename":"Issue","id":"I_kw1"}}}}"#;
const THREAD_OF_PR_7: &str = r#"{"data":{"node":{"pullRequest":{"number":7,"repository":{"name":"termul","owner":{"login":"me"}}}}}}"#;
const CREATED: &str = r#"{"id":"IC_9","body":"hi","createdAt":"2026-10-31T06:00:00Z","url":"https://github.com/me/termul/issues/7#issuecomment-9","author":{"login":"octo"}}"#;
const SEARCH: &str = r#"{"data":{"search":{"nodes":[]}}}"#;

fn query_has(args: &[String], needle: &str) -> bool {
    args.iter()
        .any(|arg| arg.starts_with("query=") && arg.contains(needle))
}

/// gh signed in to github.com; `#7` is an issue whose comments and PR
/// threads accept writes.
fn standard(args: &[String], stdin: Option<&str>) -> Reply {
    if args[0] == "auth" {
        return ok(AUTH);
    }
    if query_has(args, "search(") {
        return ok(SEARCH);
    }
    if query_has(args, "issueOrPullRequest(number") {
        return ok(ISSUE_SUBJECT);
    }
    if query_has(args, "node(id") {
        return ok(THREAD_OF_PR_7);
    }
    if has(args, "--input") {
        let stdin = stdin.expect("mutation on stdin");
        return if stdin.contains("addComment(") {
            ok(&format!(
                r#"{{"data":{{"addComment":{{"commentEdge":{{"node":{CREATED}}}}}}}}}"#
            ))
        } else {
            ok(&format!(
                r#"{{"data":{{"addPullRequestReviewThreadReply":{{"comment":{CREATED}}}}}}}"#
            ))
        };
    }
    panic!("unscripted gh call: {args:?}");
}

fn request(
    cwd: String,
    kind: GithubItemKind,
    target: GithubCommentTarget,
    body: &str,
) -> GithubCommentRequest {
    GithubCommentRequest {
        cwd,
        repo: GithubRepoSlot::Origin,
        kind,
        number: 7,
        target,
        body: body.to_string(),
    }
}

fn created() -> GithubComment {
    GithubComment {
        id: "IC_9".into(),
        author: "octo".into(),
        body: "hi".into(),
        created_at: "2026-10-31T06:00:00Z".into(),
        url: "https://github.com/me/termul/issues/7#issuecomment-9".into(),
    }
}

fn list(cwd: String) -> GithubListRequest {
    GithubListRequest {
        cwd,
        filter: GithubListFilter {
            repo: GithubRepoSlot::Origin,
            kind: GithubKindFilter::All,
            state: GithubStateFilter::Open,
            assigned_to_me: false,
            review_requested: false,
        },
        refresh: false,
    }
}

#[test]
fn blank_or_oversized_bodies_are_refused_before_any_gh_call() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(standard));
    let blank = service.comment(&request(
        project.cwd(),
        GithubItemKind::Issue,
        GithubCommentTarget::Conversation,
        " \n\t",
    ));
    assert_eq!(blank.unwrap_err(), GithubError::EmptyComment);
    let huge = service.comment(&request(
        project.cwd(),
        GithubItemKind::Issue,
        GithubCommentTarget::Conversation,
        &"é".repeat(65_537),
    ));
    assert_eq!(
        huge.unwrap_err().to_string(),
        "The comment is 65537 characters; GitHub accepts at most 65536"
    );
    assert!(log.calls().is_empty(), "{:?}", log.calls());
}

#[test]
fn conversation_comment_sends_the_body_on_stdin_and_returns_the_created_comment() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(standard));
    service.list_items(&list(project.cwd())).unwrap();
    let body = "Looks good; `rm -rf $(pwd)` & \"quotes\"\nsecond line";
    let result = service
        .comment(&request(
            project.cwd(),
            GithubItemKind::Issue,
            GithubCommentTarget::Conversation,
            body,
        ))
        .unwrap();
    assert_eq!(result, GithubCommentResult { comment: created() });

    let sent: serde_json::Value = serde_json::from_str(&log.stdins()[0]).unwrap();
    assert_eq!(
        sent["variables"],
        serde_json::json!({ "subjectId": "I_kw1", "body": body })
    );
    assert!(!sent["query"].as_str().unwrap().contains("Looks good"));
    assert!(
        log.calls().iter().all(|call| !call.contains("Looks good")),
        "the body never reaches argv: {:?}",
        log.calls()
    );
    assert_eq!(
        log.calls().last().unwrap(),
        "github.com api graphql --input -"
    );

    service.list_items(&list(project.cwd())).unwrap();
    assert_eq!(
        log.count_containing("q=repo:"),
        2,
        "the write dropped the cached list"
    );
}

#[test]
fn a_comment_aimed_at_the_wrong_kind_is_not_found_and_writes_nothing() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(standard));
    let error = service
        .comment(&request(
            project.cwd(),
            GithubItemKind::Pr,
            GithubCommentTarget::Conversation,
            "hi",
        ))
        .unwrap_err();
    assert_eq!(
        error,
        GithubError::NotFound("#7 is not a pull request".into())
    );
    assert!(log.stdins().is_empty());
}

#[test]
fn thread_reply_checks_the_thread_belongs_to_the_pr() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(standard));
    let reply = |number: u64, kind: GithubItemKind| {
        service.comment(&GithubCommentRequest {
            number,
            ..request(
                project.cwd(),
                kind,
                GithubCommentTarget::ReviewThread {
                    thread_id: "PRRT_1".into(),
                },
                "fixed",
            )
        })
    };

    assert_eq!(
        reply(7, GithubItemKind::Pr).unwrap(),
        GithubCommentResult { comment: created() }
    );
    let sent: serde_json::Value = serde_json::from_str(&log.stdins()[0]).unwrap();
    assert_eq!(
        sent["variables"],
        serde_json::json!({ "threadId": "PRRT_1", "body": "fixed" })
    );

    assert_eq!(
        reply(8, GithubItemKind::Pr).unwrap_err(),
        GithubError::NotFound("review thread on pull request #8 of github.com/me/termul".into())
    );
    assert_eq!(
        reply(7, GithubItemKind::Issue).unwrap_err().to_string(),
        "Only pull requests have review threads"
    );
    assert_eq!(log.stdins().len(), 1, "only the valid reply was sent");
}

#[test]
fn a_failed_mutation_reports_gh_and_still_drops_cached_reads() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(|args, stdin| {
        if has(args, "--input") {
            fail("GraphQL: Resource not accessible by integration (addComment)")
        } else {
            standard(args, stdin)
        }
    }));
    service.list_items(&list(project.cwd())).unwrap();
    let error = service
        .comment(&request(
            project.cwd(),
            GithubItemKind::Issue,
            GithubCommentTarget::Conversation,
            "hi",
        ))
        .unwrap_err();
    assert_eq!(error.code(), "GH_FAILED");
    service.list_items(&list(project.cwd())).unwrap();
    assert_eq!(log.count_containing("q=repo:"), 2);
}

#[test]
fn comment_requests_deserialize_from_the_ts_shapes() {
    let request: GithubCommentRequest = serde_json::from_value(serde_json::json!({
        "cwd": "/p", "repo": "upstream", "kind": "pr", "number": 3,
        "target": { "kind": "review_thread", "threadId": "PRRT_x" },
        "body": "b"
    }))
    .unwrap();
    assert_eq!(
        request.target,
        GithubCommentTarget::ReviewThread {
            thread_id: "PRRT_x".into()
        }
    );
    let conversation: GithubCommentTarget =
        serde_json::from_value(serde_json::json!({ "kind": "conversation" })).unwrap();
    assert_eq!(conversation, GithubCommentTarget::Conversation);
    assert_eq!(
        serde_json::to_value(GithubCheckoutPrResult {
            head_sha: "abc".into(),
            head_ref_name: "feat".into(),
            push_command: "git push origin HEAD:feat".into(),
        })
        .unwrap(),
        serde_json::json!({ "headSha": "abc", "headRefName": "feat", "pushCommand": "git push origin HEAD:feat" })
    );
}
