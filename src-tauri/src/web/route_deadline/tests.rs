use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    http::{HeaderMap, Request},
    middleware,
    routing::post,
    Router,
};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tower::ServiceExt;

use super::*;
use crate::web::command_ledger::{
    fingerprint_of, no_entity, run_http, CommandLedger, COMMAND_ID_HEADER,
};

fn bounded(router: Router) -> Router {
    router.layer(middleware::from_fn(bound))
}

async fn post_to(router: &Router, path: &str, command_id: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::builder().method("POST").uri(path);
    if let Some(id) = command_id {
        request = request.header(COMMAND_ID_HEADER, id);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("json body"))
}

async fn hangs() -> Json<IpcBody<()>> {
    std::future::pending().await
}

#[tokio::test(start_paused = true)]
async fn a_hung_read_route_answers_timed_out_after_a_minute() {
    let router = bounded(Router::new().route("/git/status", post(hangs)));
    let started = tokio::time::Instant::now();

    let (status, body) = post_to(&router, "/git/status", None).await;

    assert_eq!(started.elapsed(), Duration::from_secs(60));
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "success": false,
            "error": "/git/status did not answer within 60s",
            "code": "TIMED_OUT",
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_hung_idempotent_write_says_it_may_still_complete() {
    let router = bounded(Router::new().route("/worktree/remove", post(hangs)));
    let started = tokio::time::Instant::now();

    let (_, body) = post_to(&router, "/worktree/remove", None).await;

    assert_eq!(started.elapsed(), Duration::from_secs(180));
    assert_eq!(
        body,
        json!({
            "success": false,
            "error": "/worktree/remove did not finish within 180s. It may still complete on the host; check its state before retrying",
            "code": "TIMED_OUT",
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_ledgered_write_past_its_deadline_replays_its_real_outcome_to_the_resend() {
    let ledger = Arc::new(CommandLedger::new(Duration::from_secs(600)));
    let release = Arc::new(Notify::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let handler = {
        let (ledger, release, runs) =
            (Arc::clone(&ledger), Arc::clone(&release), Arc::clone(&runs));
        move |headers: HeaderMap| {
            let (ledger, release, runs) =
                (Arc::clone(&ledger), Arc::clone(&release), Arc::clone(&runs));
            async move {
                let effect = async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    release.notified().await;
                    IpcBody::ok("created".to_string())
                };
                let fingerprint = fingerprint_of("worktree_create", &[("name", "wt")]);
                Json(
                    run_http(
                        &ledger,
                        &headers,
                        "worktree_create",
                        fingerprint,
                        no_entity(),
                        effect,
                    )
                    .await,
                )
            }
        }
    };
    let router = bounded(Router::new().route("/worktree/create", post(handler)));

    let (_, first) = post_to(&router, "/worktree/create", Some("cmd-1")).await;
    assert_eq!(first, json!({"success": true, "receipt": "in_progress"}));

    release.notify_one();
    let (_, resend) = post_to(&router, "/worktree/create", Some("cmd-1")).await;
    assert_eq!(resend, json!({"success": true, "data": "created"}));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_hung_write_outside_the_ledger_never_claims_in_progress_for_its_command_id() {
    let router = bounded(Router::new().route("/git/init", post(hangs)));

    let (_, body) = post_to(&router, "/git/init", Some("cmd-1")).await;

    assert_eq!(
        body,
        json!({
            "success": false,
            "error": "/git/init did not finish within 180s. It may still complete on the host; check its state before retrying",
            "code": "TIMED_OUT",
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_hung_idempotent_kind_run_through_run_http_is_not_ledgered() {
    let ledger = Arc::new(CommandLedger::new(Duration::from_secs(600)));
    let handler = move |headers: HeaderMap| {
        let ledger = Arc::clone(&ledger);
        async move {
            let fingerprint = fingerprint_of("git_stage", &[("path", "a.txt")]);
            Json(
                run_http(
                    &ledger,
                    &headers,
                    "git_stage",
                    fingerprint,
                    no_entity(),
                    async { std::future::pending::<IpcBody<()>>().await },
                )
                .await,
            )
        }
    };
    let router = bounded(Router::new().route("/git/stage", post(handler)));

    let (_, body) = post_to(&router, "/git/stage", Some("cmd-1")).await;

    assert_eq!(
        body,
        json!({
            "success": false,
            "error": "/git/stage did not finish within 180s. It may still complete on the host; check its state before retrying",
            "code": "TIMED_OUT",
        })
    );
}
