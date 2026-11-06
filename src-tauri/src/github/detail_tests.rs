use serde_json::json;

use super::fake_gh::{fake_gh_with_stdin, has, ok, service_with, Project, Reply, AUTH};
use super::types::*;

fn comment(id: &str) -> serde_json::Value {
    json!({ "id": id, "body": id, "createdAt": "t", "url": "u", "author": { "login": "a" } })
}

fn page(ids: &[String], next: Option<&str>) -> serde_json::Value {
    json!({
        "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next },
        "nodes": ids.iter().map(|id| comment(id)).collect::<Vec<_>>()
    })
}

fn ids(prefix: &str, range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|i| format!("{prefix}{i}")).collect()
}

fn thread(id: &str, comments: serde_json::Value) -> serde_json::Value {
    json!({ "id": id, "isResolved": false, "isOutdated": false, "path": "f.rs", "line": 1, "comments": comments })
}

/// PR #5: 230 conversation comments, 120 review threads (the first with 70
/// comments), served 100 / 100 / 50 per page like GitHub.
fn paged(args: &[String], stdin: Option<&str>) -> Reply {
    if args[0] == "auth" {
        return ok(AUTH);
    }
    if !has(args, "--input") {
        let threads: Vec<_> = (0..100)
            .map(|i| {
                let replies = if i == 0 {
                    page(&ids("r", 0..50), Some("r50"))
                } else {
                    page(&[format!("x{i}")], None)
                };
                thread(&format!("T{i}"), replies)
            })
            .collect();
        return ok(&json!({ "data": { "repository": { "issueOrPullRequest": {
            "__typename": "PullRequest", "number": 5, "title": "t", "state": "OPEN", "url": "u",
            "updatedAt": "t", "author": null, "body": "b", "createdAt": "t",
            "comments": { "totalCount": 230, "pageInfo": { "hasNextPage": true, "endCursor": "c100" },
                          "nodes": ids("c", 0..100).iter().map(|id| comment(id)).collect::<Vec<_>>() },
            "reviewThreads": { "pageInfo": { "hasNextPage": true, "endCursor": "t100" }, "nodes": threads }
        } } } })
        .to_string());
    }
    let request: serde_json::Value = serde_json::from_str(stdin.unwrap()).unwrap();
    let vars = &request["variables"];
    let query = request["query"].as_str().unwrap();
    if query.contains("reviewThreads(first: 100, after") {
        assert_eq!(vars["after"], "t100");
        let threads: Vec<_> = (100..120)
            .map(|i| thread(&format!("T{i}"), page(&[format!("x{i}")], None)))
            .collect();
        return ok(
            &json!({ "data": { "repository": { "pullRequest": { "reviewThreads": {
            "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": threads
        } } } } })
            .to_string(),
        );
    }
    if query.contains("comments(first: 100, after") {
        let (range, next) = match vars["after"].as_str().unwrap() {
            "c100" => (100..200, Some("c200")),
            "c200" => (200..230, None),
            other => panic!("unexpected cursor {other}"),
        };
        return ok(&json!({ "data": { "repository": { "issueOrPullRequest": {
            "comments": page(&ids("c", range), next)
        } } } })
        .to_string());
    }
    if query.contains("t0: node(") {
        assert_eq!((&vars["t0"], &vars["c0"]), (&json!("T0"), &json!("r50")));
        assert!(
            vars.get("t1").is_none(),
            "only the thread with more replies pages"
        );
        return ok(
            &json!({ "data": { "t0": { "comments": page(&ids("r", 50..70), None) } } }).to_string(),
        );
    }
    panic!("unscripted page: {query}");
}

#[test]
fn detail_follows_every_page_of_comments_threads_and_replies() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(paged));
    let detail = service
        .get_item(&GithubItemRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            kind: GithubItemKind::Pr,
            number: 5,
            refresh: false,
        })
        .unwrap();
    let comment_ids: Vec<String> = detail.comments.iter().map(|c| c.id.clone()).collect();
    assert_eq!(comment_ids, ids("c", 0..230));
    let threads = &detail.pr.as_ref().unwrap().review_threads;
    assert_eq!(
        threads.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
        ids("T", 0..120)
    );
    assert_eq!(
        threads[0]
            .comments
            .iter()
            .map(|c| c.id.clone())
            .collect::<Vec<_>>(),
        ids("r", 0..70)
    );
    assert_eq!(threads[119].comments[0].id, "x119");
    assert_eq!(
        log.count_containing("--input"),
        4,
        "two comment pages, one thread page, one batched reply page"
    );
}

#[test]
fn conversation_paging_stops_at_the_cap() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service_with(fake_gh_with_stdin(|args, stdin| {
        if args[0] == "auth" {
            return ok(AUTH);
        }
        let after = stdin.map(|s| {
            serde_json::from_str::<serde_json::Value>(s).unwrap()["variables"]["after"].clone()
        });
        let start = match after.as_ref().and_then(|a| a.as_str()) {
            None => 0,
            Some(cursor) => cursor[1..].parse().unwrap(),
        };
        let comments = page(
            &ids("c", start..start + 100),
            Some(&format!("c{}", start + 100)),
        );
        let data = if after.is_none() {
            json!({ "repository": { "issueOrPullRequest": {
                "__typename": "Issue", "number": 5, "title": "t", "state": "OPEN", "url": "u",
                "updatedAt": "t", "author": null, "body": "b", "createdAt": "t",
                "comments": { "totalCount": 9000, "pageInfo": comments["pageInfo"], "nodes": comments["nodes"] }
            } } })
        } else {
            json!({ "repository": { "issueOrPullRequest": { "comments": comments } } })
        };
        ok(&json!({ "data": data }).to_string())
    }));
    let detail = service
        .get_item(&GithubItemRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            kind: GithubItemKind::Issue,
            number: 5,
            refresh: false,
        })
        .unwrap();
    assert_eq!(detail.comments.len(), 500);
    assert_eq!(detail.item.comment_count, 9000);
    assert_eq!(log.count_containing("--input"), 4);
}
