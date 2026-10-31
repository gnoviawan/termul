use super::detail::{parse_item_node, pull_detail};
use super::error::{classify_failure, GithubError};
use super::items::{parse_search, search_query};
use super::repo::{host_allowed, parse_parent, route_remote, RemoteRoute};
use super::types::*;
use crate::git_remote::parse_remote_url;

fn repo() -> GithubRepoRef {
    GithubRepoRef {
        host: "github.com".into(),
        owner: "gnoviawan".into(),
        name: "termul".into(),
    }
}

fn filter(
    kind: GithubKindFilter,
    state: GithubStateFilter,
    assigned_to_me: bool,
    review_requested: bool,
) -> GithubListFilter {
    GithubListFilter {
        repo: GithubRepoSlot::Origin,
        kind,
        state,
        assigned_to_me,
        review_requested,
    }
}

#[test]
fn search_query_per_filter() {
    use GithubKindFilter as K;
    use GithubStateFilter as S;
    let base = "repo:gnoviawan/termul sort:updated-desc";
    let cases = [
        (filter(K::All, S::All, false, false), Some(base.to_string())),
        (
            filter(K::All, S::Open, false, false),
            Some(format!("{base} is:open")),
        ),
        (
            filter(K::Issue, S::Open, true, false),
            Some(format!("{base} is:issue is:open assignee:@me")),
        ),
        (
            filter(K::Pr, S::Closed, false, false),
            Some(format!("{base} is:pr is:closed -is:merged")),
        ),
        (
            filter(K::All, S::Closed, false, false),
            Some(format!("{base} is:closed -is:merged")),
        ),
        (
            filter(K::All, S::Merged, false, false),
            Some(format!("{base} is:pr is:merged")),
        ),
        (
            filter(K::All, S::Draft, false, false),
            Some(format!("{base} is:pr is:open draft:true")),
        ),
        (
            filter(K::All, S::Open, false, true),
            Some(format!("{base} is:pr is:open review-requested:@me")),
        ),
        (filter(K::Issue, S::Merged, false, false), None),
        (filter(K::Issue, S::All, false, true), None),
    ];
    for (filter, expected) in cases {
        assert_eq!(search_query(&repo(), &filter), expected, "{filter:?}");
    }
}

/// Trimmed `search` response from gnoviawan/termul (2026-10-30).
const SEARCH_DATA: &str = r#"{"rateLimit":{"limit":5000,"remaining":4944,"resetAt":"2026-10-31T00:24:08Z"},"search":{"nodes":[
{"__typename":"PullRequest","number":1578,"title":"feat(context-window): usage bar","state":"OPEN","isDraft":false,"merged":false,"url":"https://github.com/gnoviawan/termul/pull/1578","updatedAt":"2026-10-30T22:56:40Z","author":{"login":"julianromli"},"labels":{"nodes":[]},"assignees":{"nodes":[]},"comments":{"totalCount":1},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]}},
{"__typename":"Issue","number":1580,"title":"Upgrading the .deb deletes /usr/bin/rg","state":"OPEN","url":"https://github.com/gnoviawan/termul/issues/1580","updatedAt":"2026-10-30T20:45:44Z","author":{"login":"gnoviawan"},"labels":{"nodes":[{"name":"bug","color":"d73a4a"}]},"assignees":{"nodes":[{"login":"gnoviawan"}]},"comments":{"totalCount":0}},
{"__typename":"PullRequest","number":1574,"title":"draft","state":"OPEN","isDraft":true,"merged":false,"url":"u","updatedAt":"t","author":null,"labels":{"nodes":[]},"assignees":{"nodes":[]},"comments":{"totalCount":0},"commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}},
{"__typename":"PullRequest","number":1576,"title":"merged","state":"MERGED","isDraft":false,"merged":true,"url":"u","updatedAt":"t","author":{"login":"a"},"labels":{"nodes":[]},"assignees":{"nodes":[]},"comments":{"totalCount":3},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"ERROR"}}}]}},
{}
]}}"#;

#[test]
fn search_nodes_map_to_list_items() {
    let data: serde_json::Value = serde_json::from_str(SEARCH_DATA).unwrap();
    let items = parse_search(&data);
    assert_eq!(
        items[1],
        GithubListItem {
            kind: GithubItemKind::Issue,
            number: 1580,
            title: "Upgrading the .deb deletes /usr/bin/rg".into(),
            state: GithubItemState::Open,
            author: "gnoviawan".into(),
            labels: vec![GithubLabel {
                name: "bug".into(),
                color: "d73a4a".into()
            }],
            assignees: vec!["gnoviawan".into()],
            comment_count: 0,
            updated_at: "2026-10-30T20:45:44Z".into(),
            url: "https://github.com/gnoviawan/termul/issues/1580".into(),
            checks: None,
        }
    );
    assert_eq!(
        items
            .iter()
            .map(|i| (i.number, i.kind, i.state, i.checks, i.author.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (
                1578,
                GithubItemKind::Pr,
                GithubItemState::Open,
                Some(GithubCheckRollup::Success),
                "julianromli"
            ),
            (
                1580,
                GithubItemKind::Issue,
                GithubItemState::Open,
                None,
                "gnoviawan"
            ),
            (
                1574,
                GithubItemKind::Pr,
                GithubItemState::Draft,
                None,
                "ghost"
            ),
            (
                1576,
                GithubItemKind::Pr,
                GithubItemState::Merged,
                Some(GithubCheckRollup::Failure),
                "a"
            ),
        ]
    );
}

/// Trimmed detail response for PR #1579 (2026-10-30).
const PR_DETAIL_DATA: &str = r#"{"rateLimit":{"limit":5000,"remaining":4822,"resetAt":"2026-10-30T23:42:15Z"},"repository":{"issueOrPullRequest":{
"__typename":"PullRequest","number":1579,"title":"ci(nightly): prune","state":"OPEN","isDraft":false,"merged":false,
"url":"https://github.com/gnoviawan/termul/pull/1579","updatedAt":"2026-10-30T17:51:34Z","createdAt":"2026-10-30T17:30:10Z",
"body":"Fixes #1508.","author":{"login":"davidgrldo"},"labels":{"nodes":[]},"assignees":{"nodes":[]},
"comments":{"totalCount":2,"nodes":[
 {"id":"IC_1","body":"first","createdAt":"2026-10-30T17:30:28Z","url":"https://github.com/gnoviawan/termul/pull/1579#issuecomment-1","author":{"login":"coderabbitai"}},
 {"id":"IC_2","body":"second","createdAt":"2026-10-30T17:39:59Z","url":"https://github.com/gnoviawan/termul/pull/1579#issuecomment-2","author":null}]},
"headRefName":"ci/nightly-prune-assets-1508","headRefOid":"8f1ec978ddffdf581c36068d2abde9458d7a4266","baseRefName":"dev",
"isCrossRepository":true,"maintainerCanModify":true,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","autoMergeRequest":null,
"additions":27,"deletions":0,"changedFiles":1,
"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE"}}}]},
"reviewThreads":{"nodes":[{"id":"PRRT_1","isResolved":false,"isOutdated":false,"path":".github/workflows/nightly.yml","line":492,
 "comments":{"nodes":[{"id":"PRRC_1","body":"nit","createdAt":"2026-10-30T17:51:27Z","url":"https://github.com/gnoviawan/termul/pull/1579#discussion_r1","author":{"login":"coderabbitai"}}]}}]}
}}}"#;

#[test]
fn pr_detail_maps_merge_state_threads_and_comments() {
    let data: serde_json::Value = serde_json::from_str(PR_DETAIL_DATA).unwrap();
    let node = parse_item_node(&data, GithubItemKind::Pr, 1579).expect("pr node");
    assert_eq!(
        pull_detail(&node),
        GithubPullDetail {
            head_ref_name: "ci/nightly-prune-assets-1508".into(),
            head_sha: "8f1ec978ddffdf581c36068d2abde9458d7a4266".into(),
            base_ref_name: "dev".into(),
            is_cross_repository: true,
            maintainer_can_modify: true,
            mergeable: GithubMergeable::Mergeable,
            merge_state_status: "BLOCKED".into(),
            auto_merge_enabled: false,
            additions: 27,
            deletions: 0,
            changed_files: 1,
            review_threads: vec![GithubReviewThread {
                id: "PRRT_1".into(),
                path: ".github/workflows/nightly.yml".into(),
                line: Some(492),
                is_resolved: false,
                is_outdated: false,
                comments: vec![GithubComment {
                    id: "PRRC_1".into(),
                    author: "coderabbitai".into(),
                    body: "nit".into(),
                    created_at: "2026-10-30T17:51:27Z".into(),
                    url: "https://github.com/gnoviawan/termul/pull/1579#discussion_r1".into(),
                }],
            }],
        }
    );
    let comments: Vec<_> = node
        .comments
        .as_ref()
        .unwrap()
        .nodes
        .iter()
        .flatten()
        .map(|c| c.to_comment())
        .map(|c| (c.id, c.author))
        .collect();
    assert_eq!(
        comments,
        vec![
            ("IC_1".into(), "coderabbitai".into()),
            ("IC_2".into(), "ghost".into())
        ]
    );
}

#[test]
fn detail_of_the_wrong_kind_or_missing_number_is_not_found() {
    let data: serde_json::Value = serde_json::from_str(PR_DETAIL_DATA).unwrap();
    assert_eq!(
        parse_item_node(&data, GithubItemKind::Issue, 1579).unwrap_err(),
        GithubError::NotFound("#1579 is not an issue".into())
    );
    let missing = serde_json::json!({ "repository": { "issueOrPullRequest": null } });
    assert_eq!(
        parse_item_node(&missing, GithubItemKind::Pr, 9)
            .unwrap_err()
            .code(),
        "GH_NOT_FOUND"
    );
}

#[test]
fn fork_parent_lives_on_the_fork_host() {
    let fork = GithubRepoRef {
        host: "ghe.corp".into(),
        owner: "me".into(),
        name: "termul".into(),
    };
    let stdout =
        br#"{"parent":{"id":"R_1","name":"termul","owner":{"id":"U_1","login":"gnoviawan"}}}"#;
    assert_eq!(
        parse_parent(stdout, &fork),
        Some(Some(GithubRepoRef {
            host: "ghe.corp".into(),
            owner: "gnoviawan".into(),
            name: "termul".into(),
        }))
    );
    assert_eq!(parse_parent(br#"{"parent":null}"#, &fork), Some(None));
}

#[test]
fn remotes_route_by_forge() {
    let route = |url: &str| route_remote(parse_remote_url(url));
    assert_eq!(
        route("git@github.com:gnoviawan/termul.git"),
        RemoteRoute::Candidate(repo())
    );
    assert_eq!(route("https://gitlab.com/o/r.git"), RemoteRoute::OtherForge);
    assert_eq!(
        route("git@gitlab.corp.example:o/r.git"),
        RemoteRoute::OtherForge
    );
    assert_eq!(
        route("https://bitbucket.org/o/r.git"),
        RemoteRoute::OtherForge
    );
    assert_eq!(
        route("https://ghe.corp/team/sub/r.git"),
        RemoteRoute::NoGithubRemote
    );
    assert_eq!(route("/local/path"), RemoteRoute::NoGithubRemote);
    assert!(host_allowed("github.com", false));
    assert!(host_allowed("ghe.corp", true));
    assert!(!host_allowed("ghe.corp", false));
}

#[test]
fn gh_stderr_classifies_to_contract_codes() {
    let cases = [
        (
            "gh: Could not resolve to an issue or pull request with the number of 999999.",
            "GH_NOT_FOUND",
        ),
        ("gh: Not Found (HTTP 404)", "GH_NOT_FOUND"),
        ("gh: Bad credentials (HTTP 401)", "GH_UNAUTHENTICATED"),
        (
            "To get started with GitHub CLI, please run:  gh auth login",
            "GH_UNAUTHENTICATED",
        ),
        (
            "Pull request #5 is not mergeable: the merge commit cannot be cleanly created.",
            "GH_NOT_MERGEABLE",
        ),
        ("error connecting to api.github.com", "GH_FAILED"),
    ];
    for (stderr, code) in cases {
        assert_eq!(
            classify_failure(stderr, "github.com").code(),
            code,
            "{stderr}"
        );
    }
    assert_eq!(
        classify_failure("gh: Bad credentials (HTTP 401)", "ghe.corp"),
        GithubError::Unauthenticated {
            host: "ghe.corp".into()
        }
    );
}

#[test]
fn requests_deserialize_from_the_ts_shapes() {
    let list: GithubListRequest = serde_json::from_value(serde_json::json!({
        "cwd": "/p",
        "filter": { "repo": "upstream", "kind": "all", "state": "draft", "assignedToMe": true, "reviewRequested": false }
    }))
    .unwrap();
    assert_eq!(
        list,
        GithubListRequest {
            cwd: "/p".into(),
            filter: GithubListFilter {
                repo: GithubRepoSlot::Upstream,
                ..filter(GithubKindFilter::All, GithubStateFilter::Draft, true, false)
            },
            refresh: false,
        }
    );
    let merge: GithubMergeRequest = serde_json::from_value(serde_json::json!({
        "cwd": "/p", "repo": "origin", "number": 7,
        "action": { "kind": "enable_auto_merge", "method": "squash" }
    }))
    .unwrap();
    assert_eq!(
        merge.action,
        GithubMergeAction::EnableAutoMerge {
            method: GithubMergeMethod::Squash
        }
    );
    let log: GithubCheckLogRequest =
        serde_json::from_value(serde_json::json!({ "cwd": "/p", "repo": "origin", "jobId": 42 }))
            .unwrap();
    assert_eq!(log.job_id, 42);
    assert_eq!(
        serde_json::to_value(GithubRepoResolution::NotGithub).unwrap(),
        serde_json::json!({ "kind": "not_github" })
    );
}
