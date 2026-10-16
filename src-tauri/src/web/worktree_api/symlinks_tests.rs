use super::*;
use crate::web::worktree_api::tests::{body_as, production_router, test_state, TempDir};
use axum::body::Body;
use axum::http::Request;
use axum::routing::post;
use serde_json::json;
use tower::ServiceExt;

fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/worktree/parse-gitignore", post(parse_gitignore))
        .route("/worktree/create-symlinks", post(create_symlinks))
        .route("/worktree/ensure-symlinks", post(ensure_symlinks))
        .with_state(state)
}

fn request(uri: &str, body: &serde_json::Value, peer: SocketAddr) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .extension(ConnectInfo(peer))
        .body(Body::from(
            serde_json::to_vec(body).expect("serialize body"),
        ))
        .expect("build request")
}

async fn post_from(
    app: axum::Router,
    uri: &str,
    body: serde_json::Value,
    peer: SocketAddr,
) -> IpcBody<serde_json::Value> {
    let response = app
        .oneshot(request(uri, &body, peer))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    body_as(response.into_body()).await
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

fn lan_peer() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 54321))
}

struct Project {
    dir: TempDir,
    root: std::path::PathBuf,
    worktree: std::path::PathBuf,
}

fn project(label: &str) -> Project {
    let dir = TempDir::new(label);
    let root = dir.path().canonicalize().expect("canonical root");
    std::fs::create_dir_all(root.join("shared")).expect("shared dir");
    let worktree = root.join(".termul").join("worktrees").join("wt");
    std::fs::create_dir_all(&worktree).expect("worktree dir");
    Project {
        dir,
        root,
        worktree,
    }
}

fn s(path: &std::path::Path) -> String {
    crate::path_validation::strip_verbatim_prefix(&path.to_string_lossy()).into_owned()
}

fn link_statuses(body: &IpcBody<serde_json::Value>) -> Vec<(String, String)> {
    assert!(body.success, "expected success, got {body:?}");
    let results = body
        .data
        .as_ref()
        .and_then(|d| d.as_array())
        .expect("result array");
    results
        .iter()
        .map(|r| {
            let name = std::path::Path::new(r["path"].as_str().expect("path"))
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            (name, r["status"].as_str().expect("status").to_string())
        })
        .collect()
}

fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    expected
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[tokio::test]
async fn parse_gitignore_lists_plain_directory_entries() {
    let p = project("gitignore");
    std::fs::write(
        p.root.join(".gitignore"),
        "# deps\nshared/\n*.log\n!keep\nsrc/build/\ndist\n.claude\nshared\na&echo\n",
    )
    .expect("write .gitignore");

    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/parse-gitignore",
        json!({ "projectPath": s(&p.root) }),
        loopback(),
    )
    .await;

    assert!(body.success, "got {body:?}");
    assert_eq!(
        body.data,
        Some(json!([
            { "dirName": "shared", "exists": true },
            { "dirName": "dist", "exists": false }
        ]))
    );
}

#[tokio::test]
async fn create_symlinks_links_existing_dirs_and_skips_the_rest() {
    let p = project("create-links");
    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/create-symlinks",
        json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&p.worktree),
            "symlinkDirs": ["shared", "missing", "../escape"]
        }),
        loopback(),
    )
    .await;

    assert_eq!(
        link_statuses(&body),
        pairs(&[
            ("shared", "created"),
            ("missing", "skipped"),
            ("escape", "skipped")
        ])
    );
    assert_eq!(
        std::fs::canonicalize(p.worktree.join("shared")).expect("link resolves"),
        p.root.join("shared")
    );
    assert!(!p.root.join(".termul").join("escape").exists());
}

#[tokio::test]
async fn ensure_symlinks_leaves_an_existing_link_in_place() {
    let p = project("ensure-links");
    let app = router(test_state(p.dir.path()));
    let req = json!({
        "projectPath": s(&p.root),
        "worktreePath": s(&p.worktree),
        "symlinkDirs": ["shared"]
    });

    let first = post_from(
        app.clone(),
        "/worktree/ensure-symlinks",
        req.clone(),
        loopback(),
    )
    .await;
    let second = post_from(app, "/worktree/ensure-symlinks", req, loopback()).await;

    assert_eq!(link_statuses(&first), pairs(&[("shared", "created")]));
    assert_eq!(link_statuses(&second), pairs(&[("shared", "skipped")]));
}

#[tokio::test]
async fn symlink_writes_are_refused_from_a_non_loopback_peer() {
    let p = project("links-lan");
    for uri in ["/worktree/create-symlinks", "/worktree/ensure-symlinks"] {
        let body = post_from(
            router(test_state(p.dir.path())),
            uri,
            json!({
                "projectPath": s(&p.root),
                "worktreePath": s(&p.worktree),
                "symlinkDirs": ["shared"]
            }),
            lan_peer(),
        )
        .await;
        assert!(!body.success, "{uri}");
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"), "{uri}");
    }
    assert!(!p.worktree.join("shared").exists());
}

#[tokio::test]
async fn symlink_writes_refuse_a_worktree_outside_every_project() {
    let p = project("links-inside");
    let outside = TempDir::new("links-outside");
    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/create-symlinks",
        json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&outside.path().canonicalize().expect("outside")),
            "symlinkDirs": ["shared"]
        }),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    assert!(!outside.path().join("shared").exists());
}

#[tokio::test]
async fn production_router_serves_the_symlink_routes() {
    let p = project("links-prod");
    for uri in [
        "/worktree/parse-gitignore",
        "/worktree/create-symlinks",
        "/worktree/ensure-symlinks",
    ] {
        let body = json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&p.worktree),
            "symlinkDirs": []
        });
        let response = production_router(p.dir.path())
            .oneshot(request(uri, &body, loopback()))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        let parsed: IpcBody<serde_json::Value> = body_as(response.into_body()).await;
        assert!(parsed.success, "{uri}: got {parsed:?}");
        assert_eq!(parsed.data, Some(json!([])), "{uri}");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn create_symlinks_refuses_rooted_and_drive_relative_names() {
    let p = project("links-rooted");
    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/create-symlinks",
        json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&p.worktree),
            "symlinkDirs": ["\\termul-rooted-escape", "C:termul-drive-escape"]
        }),
        loopback(),
    )
    .await;
    let statuses: Vec<String> = link_statuses(&body)
        .into_iter()
        .map(|(_, status)| status)
        .collect();
    assert_eq!(statuses, vec!["skipped", "skipped"]);
    let reasons: Vec<&str> = body
        .data
        .as_ref()
        .and_then(|d| d.as_array())
        .expect("results")
        .iter()
        .map(|r| r["reason"].as_str().expect("reason"))
        .collect();
    assert!(
        reasons
            .iter()
            .all(|r| r.starts_with("Invalid symlink directory name")),
        "{reasons:?}"
    );
}

fn verdicts(body: &IpcBody<serde_json::Value>) -> Vec<(String, String)> {
    assert!(body.success, "expected success, got {body:?}");
    body.data
        .as_ref()
        .and_then(|d| d.as_array())
        .expect("result array")
        .iter()
        .map(|r| {
            let reason = r["reason"].as_str().unwrap_or_default();
            let verdict = if reason.starts_with("Invalid symlink directory name") {
                "invalid"
            } else {
                reason
            };
            (
                r["status"].as_str().expect("status").to_string(),
                verdict.to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn create_symlinks_refuses_nested_names_and_cmd_metacharacters() {
    let p = project("links-names");
    let names = [
        "a/b", "a\\b", "a&echo", "p|q", "lt<x", "gt>x", "car^x", "pct%x", "bang!x", "q\"x",
        "par(x)", "c,d", "tab\tx",
    ];
    for name in names {
        let _ = std::fs::create_dir_all(p.root.join(name));
    }
    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/create-symlinks",
        json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&p.worktree),
            "symlinkDirs": names
        }),
        loopback(),
    )
    .await;

    let expected: Vec<(String, String)> = names
        .iter()
        .map(|_| ("skipped".to_string(), "invalid".to_string()))
        .collect();
    assert_eq!(verdicts(&body), expected);
    assert_eq!(
        std::fs::read_dir(&p.worktree).expect("worktree").count(),
        0,
        "no link or parent dir may be created for a refused name"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn create_symlinks_cannot_follow_a_committed_intermediate_link_outside() {
    let p = project("links-intermediate");
    let outside = TempDir::new("links-intermediate-outside");
    std::fs::create_dir_all(p.root.join("a").join("b")).expect("nested source");
    std::os::unix::fs::symlink(outside.path(), p.worktree.join("a")).expect("intermediate link");

    let body = post_from(
        router(test_state(p.dir.path())),
        "/worktree/create-symlinks",
        json!({
            "projectPath": s(&p.root),
            "worktreePath": s(&p.worktree),
            "symlinkDirs": ["a/b"]
        }),
        loopback(),
    )
    .await;

    assert_eq!(
        verdicts(&body),
        vec![("skipped".to_string(), "invalid".to_string())]
    );
    assert!(!outside.path().join("b").exists());
}
