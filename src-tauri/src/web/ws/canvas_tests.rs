#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The canvas gateway's renderer leg through the real `/ws` dispatch: a
//! `canvas_mount` makes the connection the holder, the router's call lands
//! on the connection's outbound queue as a `canvas_call` frame, and the
//! connection's `canvas_reply` resolves it.

use super::tests::{route, test_env, test_outbound};
use super::*;
use std::time::Duration;

use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasErrorCode};
use crate::canvas::persistence::TEST_RENDERER;
use crate::web::project_registry::ProjectRegistry;

fn request(id: &str, type_: &str, payload: Value) -> String {
    json!({ "id": id, "type": type_, "payload": payload }).to_string()
}

/// The connection authenticated as the window or tab `client_instance_id`.
pub(super) fn as_renderer(env: HandlerEnv, client_instance_id: &str) -> HandlerEnv {
    env.identity
        .set(ClientIdentity {
            device_id: "device".into(),
            client_instance_id: client_instance_id.into(),
        })
        .unwrap();
    env
}

#[tokio::test]
async fn a_mounted_connection_serves_canvas_calls_over_its_queue() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = test_outbound();
    let env = as_renderer(
        test_env(&acp, &relay, &registry, &tx, &Arc::default()),
        TEST_RENDERER,
    );
    acp.canvas_router().mounts().ensure_test_mount("proj-1", 2);

    let mounted = route(
        &request(
            "m1",
            "canvas_mount",
            json!({ "projectId": "proj-1", "mountSeq": 2 }),
        ),
        &env,
    )
    .await;
    assert_eq!(mounted.payload, Some(json!({ "attached": true })));

    let router = acp.canvas_router();
    let call = tokio::spawn(async move {
        router
            .call(
                "proj-1",
                "node.get",
                r#"{"id":18446744073709551615}"#.into(),
            )
            .await
    });
    let frame = match rx.recv().await.expect("a canvas_call frame") {
        Outbound::Canvas(frame) => frame,
        _ => panic!("expected a canvas_call frame"),
    };
    let wire = serde_json::to_value(&frame).unwrap();
    assert_eq!(wire["type"], "canvas_call");
    assert_eq!(wire["projectId"], "proj-1");
    assert_eq!(wire["mountSeq"], 2);
    assert_eq!(wire["params"], r#"{"id":18446744073709551615}"#);

    let replied = route(
        &request(
            "r1",
            "canvas_reply",
            json!({
                "callId": frame.call_id,
                "mountSeq": 2,
                "ok": true,
                "result": r#"{"id":18446744073709551615}"#,
            }),
        ),
        &env,
    )
    .await;
    assert_eq!(replied.payload, Some(json!({ "resolved": true })));
    assert_eq!(
        call.await.unwrap(),
        Ok(r#"{"id":18446744073709551615}"#.to_string())
    );

    let unmounted = route(
        &request(
            "u1",
            "canvas_unmount",
            json!({ "projectId": "proj-1", "mountSeq": 2 }),
        ),
        &env,
    )
    .await;
    assert_eq!(unmounted.payload, Some(json!({ "unmounted": true })));
    let after = acp
        .canvas_router()
        .call("proj-1", "node.get", "{}".into())
        .await;
    assert_eq!(after.unwrap_err().code, CanvasErrorCode::CanvasClosed);
}

#[tokio::test]
async fn another_connection_cannot_answer_or_unmount_a_call_it_does_not_hold() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (holder_tx, mut holder_rx) = test_outbound();
    let (other_tx, _other_rx) = test_outbound();
    let holder = as_renderer(
        test_env(&acp, &relay, &registry, &holder_tx, &Arc::default()),
        TEST_RENDERER,
    );
    let other = test_env(&acp, &relay, &registry, &other_tx, &Arc::default());
    acp.canvas_router().mounts().ensure_test_mount("proj-1", 1);

    route(
        &request(
            "m1",
            "canvas_mount",
            json!({ "projectId": "proj-1", "mountSeq": 1 }),
        ),
        &holder,
    )
    .await;
    let router = acp.canvas_router();
    router.set_call_timeout(Duration::from_millis(200));
    let call =
        tokio::spawn(async move { router.call("proj-1", "document.inspect", "{}".into()).await });
    let Some(Outbound::Canvas(frame)) = holder_rx.recv().await else {
        panic!("expected a canvas_call frame");
    };

    let forged = route(
        &request(
            "r1",
            "canvas_reply",
            json!({ "callId": frame.call_id, "mountSeq": 1, "ok": true, "result": "{}" }),
        ),
        &other,
    )
    .await;
    assert_eq!(forged.payload, Some(json!({ "resolved": false })));
    let unmounted = route(
        &request(
            "u1",
            "canvas_unmount",
            json!({ "projectId": "proj-1", "mountSeq": 1 }),
        ),
        &other,
    )
    .await;
    assert_eq!(unmounted.payload, Some(json!({ "unmounted": false })));
    assert_eq!(
        call.await.unwrap().unwrap_err().code,
        CanvasErrorCode::CanvasTimeout
    );
}

#[tokio::test]
async fn a_malformed_canvas_payload_is_refused() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, _rx) = test_outbound();
    let env = test_env(&acp, &relay, &registry, &tx, &Arc::default());
    for (type_, payload) in [
        ("canvas_mount", json!({ "projectId": "proj-1" })),
        ("canvas_unmount", json!({ "mountSeq": 1 })),
        ("canvas_reply", json!({ "ok": true })),
    ] {
        let reply = route(&request("x", type_, payload), &env).await;
        assert!(!reply.ok, "{type_} must refuse a malformed payload");
    }
}

async fn reply_to_next(
    rx: &mut tokio::sync::mpsc::Receiver<Outbound>,
    env: &HandlerEnv,
    method: &str,
    result: &str,
) -> CanvasCallFrame {
    let frame = loop {
        match rx.recv().await.expect("a canvas_call frame") {
            Outbound::Canvas(frame) => break frame,
            _ => continue,
        }
    };
    assert_eq!(frame.method, method);
    let replied = route(
        &request(
            "r",
            "canvas_reply",
            json!({ "callId": frame.call_id, "mountSeq": frame.mount_seq, "ok": true, "result": result }),
        ),
        env,
    )
    .await;
    assert_eq!(replied.payload, Some(json!({ "resolved": true })));
    frame
}

#[tokio::test]
async fn closing_a_dirty_canvas_snapshots_it_over_the_socket_before_unmounting() {
    use crate::canvas::persistence::CloseMode;
    use base64::Engine as _;

    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = test_outbound();
    let env = as_renderer(
        test_env(&acp, &relay, &registry, &tx, &Arc::default()),
        TEST_RENDERER,
    );
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("design.figcraft");
    std::fs::write(&doc, b"v1").unwrap();

    let mounts = Arc::clone(acp.canvas_router().mounts());
    let seq = mounts.mount("proj-close", doc.clone(), Duration::from_secs(60));
    mounts.document_loaded("proj-close", seq, Some(1)).unwrap();
    let pending = Arc::clone(&mounts);
    let debounce =
        tokio::spawn(async move { pending.dirty_changed("proj-close", seq, true, 2).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mounted = route(
        &request(
            "m1",
            "canvas_mount",
            json!({ "projectId": "proj-close", "mountSeq": seq }),
        ),
        &env,
    )
    .await;
    assert_eq!(mounted.payload, Some(json!({ "attached": true })));

    let closer = Arc::clone(&mounts);
    let close = tokio::spawn(async move { closer.close("proj-close", CloseMode::Save).await });
    let snapshot = format!(
        r#"{{"contentVersion":2,"bytes":"{}"}}"#,
        base64::engine::general_purpose::STANDARD.encode(b"v2")
    );
    reply_to_next(&mut rx, &env, "host.snapshot", &snapshot).await;
    let verify = reply_to_next(
        &mut rx,
        &env,
        "host.markSaved",
        r#"{"dirty":false,"contentVersion":2}"#,
    )
    .await;
    assert_eq!(verify.params, r#"{"contentVersion":2}"#);

    let outcome = close.await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert_eq!(outcome.saved_version.as_deref(), Some("2"));
    assert_eq!(std::fs::read(&doc).unwrap(), b"v2", "the edit is on disk");
    assert!(matches!(
        debounce.await.unwrap(),
        Ok(crate::canvas::persistence::DirtyOutcome::Superseded)
    ));
    let after = acp
        .canvas_router()
        .call("proj-close", "node.get", "{}".into())
        .await;
    assert_eq!(after.unwrap_err().code, CanvasErrorCode::CanvasClosed);
}

#[tokio::test]
async fn a_takeover_tells_the_old_connection_and_calls_follow_the_lease() {
    use crate::canvas::persistence::{
        MountRequest, RendererId, DEFAULT_CRASH_TIMEOUTS, DEFAULT_MAX_MOUNTED,
    };

    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (a_tx, mut a_rx) = test_outbound();
    let (b_tx, mut b_rx) = test_outbound();
    let tab_a = as_renderer(
        test_env(&acp, &relay, &registry, &a_tx, &Arc::default()),
        "tab-a",
    );
    let tab_b = as_renderer(
        test_env(&acp, &relay, &registry, &b_tx, &Arc::default()),
        "tab-b",
    );
    let dir = tempfile::tempdir().unwrap();
    let opens = |tab: &str| MountRequest {
        renderer: RendererId::new(tab),
        doc_path: dir.path().join("design.figcraft"),
        autosave: Duration::from_secs(60),
        autosave_max: crate::canvas::persistence::autosave_max_wait(None),
        lease_grace: Duration::from_secs(5),
        crash_timeouts: DEFAULT_CRASH_TIMEOUTS,
    };
    let mounts = Arc::clone(acp.canvas_router().mounts());
    let mount = |seq: u64| {
        request(
            "m",
            "canvas_mount",
            json!({ "projectId": "proj-lease", "mountSeq": seq }),
        )
    };

    let first = mounts
        .open("proj-lease", opens("tab-a"), DEFAULT_MAX_MOUNTED)
        .await
        .opened
        .unwrap();
    let refused = route(&mount(first.mount_seq), &tab_b).await;
    assert_eq!(
        refused.payload,
        Some(json!({ "attached": false, "heldElsewhere": true })),
        "tab-b does not hold the lease"
    );
    let attached = route(&mount(first.mount_seq), &tab_a).await;
    assert_eq!(attached.payload, Some(json!({ "attached": true })));

    let second = mounts
        .open("proj-lease", opens("tab-b"), DEFAULT_MAX_MOUNTED)
        .await
        .opened
        .unwrap();
    let Some(Outbound::CanvasLeaseLost(notice)) = a_rx.recv().await else {
        panic!("expected a canvas_lease_lost frame");
    };
    assert_eq!(
        serde_json::to_value(&notice).unwrap(),
        json!({
            "type": "canvas_lease_lost",
            "projectId": "proj-lease",
            "mountSeq": first.mount_seq,
            "reason": "takenOver"
        })
    );
    let attached = route(&mount(second.mount_seq), &tab_b).await;
    assert_eq!(attached.payload, Some(json!({ "attached": true })));

    let router = acp.canvas_router();
    router.set_call_timeout(Duration::from_millis(200));
    let call =
        tokio::spawn(async move { router.call("proj-lease", "node.get", "{}".into()).await });
    let Some(Outbound::Canvas(frame)) = b_rx.recv().await else {
        panic!("expected the call on the new holder's queue");
    };
    assert_eq!(frame.mount_seq, second.mount_seq);
    assert!(a_rx.try_recv().is_err(), "the old holder gets no call");
    assert_eq!(
        call.await.unwrap().unwrap_err().code,
        CanvasErrorCode::CanvasTimeout
    );
}
