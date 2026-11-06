use serde_json::json;

use super::fake_gh::{fail, fake_gh_with_stdin, has, ok, service_with, Project, Reply, AUTH};
use super::runner::SpawnFailure;
use super::types::*;
use super::GithubError;

const ORIGIN: &str = "https://github.com/me/termul.git";

fn query_has(args: &[String], needle: &str) -> bool {
    args.iter()
        .any(|arg| arg.starts_with("query=") && arg.contains(needle))
}

fn repo_data(item: serde_json::Value) -> serde_json::Value {
    json!({ "data": {
        "viewer": { "id": "U_octo", "login": "octo" },
        "repository": {
            "labels": { "nodes": [
                { "id": "LA_bug", "name": "bug", "color": "d73a4a", "description": "Something isn't working" },
                { "id": "LA_ai", "name": "ai", "color": "0e8a16", "description": "" }
            ] },
            "assignableUsers": { "nodes": [ { "id": "U_ana", "login": "Ana" } ] },
            "issueOrPullRequest": item
        }
    } })
}

/// Issue #7 carries `legacy`, a label past the repository's first 100, and
/// is assigned to `ana`.
fn issue_7() -> serde_json::Value {
    json!({
        "__typename": "Issue", "id": "I_7",
        "labels": { "nodes": [ { "id": "LA_legacy", "name": "legacy" } ] },
        "assignees": { "nodes": [ { "id": "U_ana", "login": "ana" } ] }
    })
}

/// gh signed in to github.com; `mutation` answers every write on stdin.
fn gh(
    mutation: impl Fn(&str) -> Reply + Send + Sync + 'static,
) -> impl Fn(&[String], Option<&str>) -> Reply + Send + Sync + 'static {
    move |args, stdin| {
        if args[0] == "auth" {
            return ok(AUTH);
        }
        if args[0] == "label" {
            return ok("");
        }
        if has(args, "--input") {
            return mutation(stdin.expect("mutation on stdin"));
        }
        if query_has(args, "search(") {
            return ok(r#"{"data":{"search":{"nodes":[]}}}"#);
        }
        if query_has(args, "assignableUsers") {
            return ok(&repo_data(issue_7()).to_string());
        }
        if query_has(args, "issueOrPullRequest(number") {
            return ok(
                r#"{"data":{"repository":{"issueOrPullRequest":{"__typename":"Issue","id":"I_7"}}}}"#,
            );
        }
        panic!("unscripted gh call: {args:?}");
    }
}

fn applied(_: &str) -> Reply {
    ok(r#"{"data":{"x":{"clientMutationId":null}}}"#)
}

fn list(cwd: String) -> GithubListRequest {
    GithubListRequest {
        cwd,
        filter: GithubListFilter {
            repo: GithubRepoSlot::Origin,
            kind: GithubKindFilter::All,
            state: GithubStateFilter::Open,
            search: String::new(),
            labels: Vec::new(),
            label_mode: GithubLabelMode::Any,
            assignee: GithubAssigneeFilter::Anyone,
            review_requested: false,
            sort: GithubSort::Updated,
        },
        refresh: false,
    }
}

fn edit(cwd: String, kind: GithubItemKind) -> GithubEditItemRequest {
    GithubEditItemRequest {
        cwd,
        repo: GithubRepoSlot::Origin,
        kind,
        number: 7,
        add_labels: Vec::new(),
        remove_labels: Vec::new(),
        add_assignees: Vec::new(),
        remove_assignees: Vec::new(),
    }
}

fn mutations(log: &super::fake_gh::CallLog) -> Vec<serde_json::Value> {
    log.stdins()
        .iter()
        .map(|stdin| serde_json::from_str(stdin).unwrap())
        .collect()
}

#[test]
fn repo_meta_lists_labels_people_and_viewer_and_is_cached() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let request = GithubRepoMetaRequest {
        cwd: project.cwd(),
        repo: GithubRepoSlot::Origin,
        refresh: false,
    };
    let meta = service.repo_meta(&request).expect("meta");
    assert_eq!(
        (meta.labels, meta.assignable_users, meta.viewer.as_str()),
        (
            vec![
                GithubRepoLabel {
                    name: "bug".into(),
                    color: "d73a4a".into(),
                    description: Some("Something isn't working".into()),
                },
                GithubRepoLabel {
                    name: "ai".into(),
                    color: "0e8a16".into(),
                    description: None,
                },
            ],
            vec!["Ana".to_string()],
            "octo"
        )
    );
    service.repo_meta(&request).expect("cached meta");
    assert_eq!(log.count_containing("query=…"), 1);
    service
        .repo_meta(&GithubRepoMetaRequest {
            refresh: true,
            ..request
        })
        .expect("refreshed meta");
    assert_eq!(log.count_containing("query=…"), 2);
}

#[test]
fn edit_resolves_names_to_ids_in_one_mutation_and_drops_cached_reads() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    service.list_items(&list(project.cwd())).unwrap();
    let result = service.edit_item(&GithubEditItemRequest {
        add_labels: vec!["BUG".into(), "ai".into()],
        remove_labels: vec!["legacy".into()],
        add_assignees: vec!["octo".into()],
        remove_assignees: vec!["ANA".into()],
        ..edit(project.cwd(), GithubItemKind::Issue)
    });
    assert_eq!(result, Ok(GithubEditItemResult { number: 7 }));
    let sent = mutations(&log);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0]["variables"],
        json!({
            "id": "I_7",
            "addLabels": ["LA_bug", "LA_ai"],
            "removeLabels": ["LA_legacy"],
            "addAssignees": ["U_octo"],
            "removeAssignees": ["U_ana"]
        })
    );
    let mutation = sent[0]["query"].as_str().unwrap();
    for field in [
        "addLabelsToLabelable(",
        "removeLabelsFromLabelable(",
        "addAssigneesToAssignable(",
        "removeAssigneesFromAssignable(",
    ] {
        assert!(mutation.contains(field), "{mutation}");
    }
    service.list_items(&list(project.cwd())).unwrap();
    assert_eq!(
        log.count_containing("q=repo:"),
        2,
        "the edit dropped the cached list"
    );
}

#[test]
fn an_edit_declares_only_the_changes_it_makes() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    service
        .edit_item(&GithubEditItemRequest {
            remove_labels: vec!["bug".into()],
            ..edit(project.cwd(), GithubItemKind::Issue)
        })
        .unwrap();
    let sent = mutations(&log);
    assert_eq!(
        sent[0]["query"],
        "mutation($id: ID!, $removeLabels: [ID!]!) { removeLabels: removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $removeLabels }) { clientMutationId } }"
    );
    assert_eq!(
        sent[0]["variables"],
        json!({ "id": "I_7", "removeLabels": ["LA_bug"] })
    );
}

#[test]
fn an_unknown_name_or_wrong_kind_is_refused_before_any_write() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let unknown = service.edit_item(&GithubEditItemRequest {
        add_labels: vec!["bug".into(), "wontfix".into()],
        ..edit(project.cwd(), GithubItemKind::Issue)
    });
    assert_eq!(
        unknown,
        Err(GithubError::Refused(
            "Label \"wontfix\" is not in this repository".into()
        ))
    );
    let stranger = service.edit_item(&GithubEditItemRequest {
        add_assignees: vec!["mallory".into()],
        ..edit(project.cwd(), GithubItemKind::Issue)
    });
    assert_eq!(
        stranger.unwrap_err().to_string(),
        "Assignee \"mallory\" is not in this repository"
    );
    let wrong_kind = service.edit_item(&GithubEditItemRequest {
        add_labels: vec!["bug".into()],
        ..edit(project.cwd(), GithubItemKind::Pr)
    });
    assert_eq!(
        wrong_kind,
        Err(GithubError::NotFound("#7 is not a pull request".into()))
    );
    assert!(log.stdins().is_empty(), "{:?}", log.stdins());
}

#[test]
fn an_empty_edit_makes_no_github_call() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let result = service.edit_item(&edit(project.cwd(), GithubItemKind::Issue));
    assert_eq!(result, Ok(GithubEditItemResult { number: 7 }));
    assert_eq!(log.count_containing("graphql"), 0, "{:?}", log.calls());
}

#[test]
fn a_timed_out_edit_says_it_may_be_applied_and_drops_cached_reads() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(|_| Err(SpawnFailure::TimedOut))));
    service.list_items(&list(project.cwd())).unwrap();
    let error = service
        .edit_item(&GithubEditItemRequest {
            add_labels: vec!["ai".into()],
            ..edit(project.cwd(), GithubItemKind::Issue)
        })
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "gh failed: gh did not respond in time, so the change may already be applied; reload the item before trying again"
    );
    service.list_items(&list(project.cwd())).unwrap();
    assert_eq!(log.count_containing("q=repo:"), 2);
}

#[test]
fn close_and_reopen_pick_the_mutation_for_the_item_kind() {
    let project = Project::new(Some(ORIGIN));
    let state = |kind, action| GithubSetItemStateRequest {
        cwd: project.cwd(),
        repo: GithubRepoSlot::Origin,
        kind,
        number: 7,
        action,
    };
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let close = GithubItemStateAction::Close {
        reason: GithubCloseReason::NotPlanned,
    };
    assert_eq!(
        service.set_item_state(&state(GithubItemKind::Issue, close)),
        Ok(GithubSetItemStateResult { number: 7 })
    );
    service
        .set_item_state(&state(GithubItemKind::Issue, GithubItemStateAction::Reopen))
        .unwrap();
    let sent = mutations(&log);
    assert!(sent[0]["query"]
        .as_str()
        .unwrap()
        .contains("closeIssue(input: { issueId: $id, stateReason: $reason })"));
    assert_eq!(
        sent[0]["variables"],
        json!({ "id": "I_7", "reason": "NOT_PLANNED" })
    );
    assert!(sent[1]["query"].as_str().unwrap().contains("reopenIssue("));
    assert_eq!(sent[1]["variables"], json!({ "id": "I_7" }));

    let pr = |args: &[String], stdin: Option<&str>| {
        if query_has(args, "issueOrPullRequest(number") {
            return ok(
                r#"{"data":{"repository":{"issueOrPullRequest":{"__typename":"PullRequest","id":"PR_7"}}}}"#,
            );
        }
        gh(applied)(args, stdin)
    };
    let (service, log) = service_with(fake_gh_with_stdin(pr));
    service
        .set_item_state(&state(GithubItemKind::Pr, close))
        .unwrap();
    service
        .set_item_state(&state(GithubItemKind::Pr, GithubItemStateAction::Reopen))
        .unwrap();
    let sent = mutations(&log);
    assert_eq!(
        sent[0]["query"],
        "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }"
    );
    assert_eq!(
        sent[0]["variables"],
        json!({ "id": "PR_7" }),
        "a PR close has no reason"
    );
    assert!(sent[1]["query"]
        .as_str()
        .unwrap()
        .contains("reopenPullRequest("));
    assert_eq!(
        service.set_item_state(&state(GithubItemKind::Issue, close)),
        Err(GithubError::NotFound("#7 is not an issue".into()))
    );
    assert_eq!(mutations(&log).len(), 2);
}

#[test]
fn create_label_keeps_user_text_out_of_gh_flags() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let result = service.create_label(&GithubCreateLabelRequest {
        cwd: project.cwd(),
        repo: GithubRepoSlot::Origin,
        name: "  --force ".into(),
        color: "#D73A4A".into(),
        description: Some(" -d evil ".into()),
    });
    assert_eq!(
        result,
        Ok(GithubCreateLabelResult {
            label: GithubRepoLabel {
                name: "--force".into(),
                color: "d73a4a".into(),
                description: Some("-d evil".into()),
            }
        })
    );
    assert!(
        log.calls().contains(
            &"github.com label create --repo=github.com/me/termul --color=d73a4a --description=-d evil -- --force"
                .to_string()
        ),
        "{:?}",
        log.calls()
    );
}

#[test]
fn an_invalid_label_is_refused_before_any_gh_call() {
    let project = Project::new(Some(ORIGIN));
    let (service, log) = service_with(fake_gh_with_stdin(gh(applied)));
    let label = |name: &str, color: &str, description: Option<&str>| GithubCreateLabelRequest {
        cwd: project.cwd(),
        repo: GithubRepoSlot::Origin,
        name: name.into(),
        color: color.into(),
        description: description.map(str::to_string),
    };
    let cases = [
        (label(" ", "d73a4a", None), "The label name is empty"),
        (
            label(&"x".repeat(51), "d73a4a", None),
            "A label name has at most 50 characters",
        ),
        (
            label("bug", "red", None),
            "\"red\" is not a six-digit hex colour",
        ),
        (
            label("bug", "d73a4z", None),
            "\"d73a4z\" is not a six-digit hex colour",
        ),
        (
            label("bug", "d73a4a", Some(&"é".repeat(101))),
            "A label description has at most 100 characters",
        ),
    ];
    for (request, message) in cases {
        let error = service.create_label(&request).unwrap_err();
        assert_eq!(
            (error.code(), error.to_string().as_str()),
            ("GH_FAILED", message)
        );
    }
    assert!(log.calls().is_empty(), "{:?}", log.calls());
}

#[test]
fn a_label_gh_rejects_fails_and_still_drops_cached_reads() {
    let project = Project::new(Some(ORIGIN));
    let reply = |args: &[String], stdin: Option<&str>| {
        if args[0] == "label" {
            return fail("label with name \"bug\" already exists; use `--force` to update its color and description");
        }
        gh(applied)(args, stdin)
    };
    let (service, log) = service_with(fake_gh_with_stdin(reply));
    service.list_items(&list(project.cwd())).unwrap();
    let error = service
        .create_label(&GithubCreateLabelRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            name: "bug".into(),
            color: "d73a4a".into(),
            description: None,
        })
        .unwrap_err();
    assert_eq!(error.code(), "GH_FAILED");
    assert!(error.to_string().contains("already exists"), "{error}");
    assert!(
        log.calls().contains(
            &"github.com label create --repo=github.com/me/termul --color=d73a4a -- bug"
                .to_string()
        ),
        "{:?}",
        log.calls()
    );
    service.list_items(&list(project.cwd())).unwrap();
    assert_eq!(log.count_containing("q=repo:"), 2);
}

#[test]
fn a_timed_out_label_create_says_it_may_be_applied() {
    let project = Project::new(Some(ORIGIN));
    let reply = |args: &[String], stdin: Option<&str>| {
        if args[0] == "label" {
            return Err(SpawnFailure::TimedOut);
        }
        gh(applied)(args, stdin)
    };
    let (service, _) = service_with(fake_gh_with_stdin(reply));
    let error = service
        .create_label(&GithubCreateLabelRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            name: "bug".into(),
            color: "d73a4a".into(),
            description: None,
        })
        .unwrap_err();
    assert_eq!(
        (error.code(), error.to_string().as_str()),
        (
            "GH_FAILED",
            "gh failed: gh did not respond in time, so the change may already be applied; reload the item before trying again"
        )
    );
}
