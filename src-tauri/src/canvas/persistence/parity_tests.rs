//! The desktop commands and the web routes are two transports of one
//! service: the same request through either yields the same envelope.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::canvas::static_server::{open_canvas, same_origin_base};
use crate::commands::{
    canvas_close, canvas_dirty_changed, canvas_document_loaded, canvas_read_document,
    canvas_write_snapshot,
};
use crate::web::canvas_api::{canvas_router, CanvasState};
use crate::web::capabilities::WriteFlags;

fn web_app() -> Router {
    canvas_router(CanvasState {
        pool: None,
        web_auth: None,
        boundary: None,
        write_flags: WriteFlags {
            allow_remote_writes: false,
            shared_live_writes_denied: false,
        },
    })
}

async fn post(route: &str, body: Value) -> Value {
    let response = web_app()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(route)
                .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                    [127, 0, 0, 1],
                    54321,
                ))))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{route}");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn tauri<T: serde::Serialize>(result: Result<crate::commands::IpcResult<T>, String>) -> Value {
    serde_json::to_value(result.unwrap()).unwrap()
}

/// One mount per transport, each in its own project and directory.
fn open(project_id: &str, dir: &tempfile::TempDir) -> u64 {
    let doc = dir.path().join("design.figcraft");
    open_canvas(
        same_origin_base(),
        project_id,
        doc.to_string_lossy().into_owned(),
        Some(100),
    )
    .unwrap()
    .mount_seq
}

/// Run the whole persistence sequence through one transport and collect the
/// replies with the transport-specific `mountSeq` blanked out.
async fn run_sequence<F, Fut>(project_id: &str, mount_seq: u64, call: F) -> Vec<Value>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let id = |extra: Value| {
        let mut body = json!({"projectId": project_id, "mountSeq": mount_seq});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let snapshot = format!(
        r#"{{"contentVersion":4,"bytes":"{}"}}"#,
        BASE64.encode(b"figcraft bytes")
    );
    let steps: Vec<(&'static str, Value)> = vec![
        ("write-snapshot", id(json!({"snapshot": snapshot.clone()}))),
        ("read-document", id(json!({}))),
        (
            "dirty-changed",
            id(json!({"dirty": true, "contentVersion": "2"})),
        ),
        ("document-loaded", id(json!({"ack": null}))),
        (
            "dirty-changed",
            id(json!({"dirty": true, "contentVersion": "4"})),
        ),
        ("write-snapshot", id(json!({"snapshot": snapshot}))),
        ("read-document", id(json!({}))),
        (
            "dirty-changed",
            id(json!({"dirty": false, "contentVersion": "4"})),
        ),
        (
            "dirty-changed",
            id(json!({"dirty": true, "contentVersion": "x"})),
        ),
        (
            "read-document",
            json!({"projectId": project_id, "mountSeq": mount_seq + 1_000_000}),
        ),
    ];
    let mut replies = Vec::new();
    for (route, body) in steps {
        let mut reply = call(route, body).await;
        blank_mount_seq(&mut reply);
        replies.push(reply);
    }
    replies
}

fn blank_mount_seq(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("mountSeq") {
                map.insert("mountSeq".into(), Value::Null);
            }
            map.values_mut().for_each(blank_mount_seq);
        }
        Value::Array(items) => items.iter_mut().for_each(blank_mount_seq),
        _ => {}
    }
}

async fn tauri_call(route: &'static str, body: Value) -> Value {
    let project_id = body["projectId"].as_str().unwrap().to_string();
    let mount_seq = body["mountSeq"].as_u64().unwrap();
    match route {
        "read-document" => tauri(canvas_read_document(project_id, mount_seq).await),
        "document-loaded" => tauri(
            canvas_document_loaded(
                project_id,
                mount_seq,
                body["ack"].as_str().map(str::to_string),
            )
            .await,
        ),
        "dirty-changed" => tauri(
            canvas_dirty_changed(
                project_id,
                mount_seq,
                body["dirty"].as_bool().unwrap(),
                body["contentVersion"].as_str().unwrap().to_string(),
            )
            .await,
        ),
        "write-snapshot" => tauri(
            canvas_write_snapshot(
                project_id,
                mount_seq,
                body["snapshot"].as_str().unwrap().to_string(),
            )
            .await,
        ),
        other => panic!("no command for {other}"),
    }
}

async fn web_call(route: &'static str, body: Value) -> Value {
    post(&format!("/canvas/{route}"), body).await
}

#[tokio::test]
async fn desktop_commands_and_web_routes_answer_the_same_sequence_alike() {
    let tauri_dir = tempfile::tempdir().unwrap();
    let web_dir = tempfile::tempdir().unwrap();
    let tauri_seq = open("parity-persist-tauri", &tauri_dir);
    let web_seq = open("parity-persist-web", &web_dir);

    let desktop = run_sequence("parity-persist-tauri", tauri_seq, tauri_call).await;
    let web = run_sequence("parity-persist-web", web_seq, web_call).await;
    tauri(canvas_close("parity-persist-tauri".into(), Some(true)).await);
    web_call(
        "close",
        json!({"projectId": "parity-persist-web", "discard": true}),
    )
    .await;

    assert_eq!(desktop, web);
    let codes: Vec<Value> = desktop.iter().map(|reply| reply["code"].clone()).collect();
    assert_eq!(
        codes,
        vec![
            json!("CANVAS_NOT_READY"),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            json!("INVALID_PAYLOAD"),
            json!("CANVAS_CLOSED"),
        ]
    );
    assert_eq!(desktop[1]["data"], json!({"bytes": null}), "a new document");
    assert_eq!(
        desktop[2]["data"]["kind"], "idle",
        "dirty before ready is ignored"
    );
    assert_eq!(desktop[4]["data"]["kind"], "saveDue");
    assert_eq!(desktop[5]["data"]["markSaved"], "4");
    assert_eq!(
        desktop[6]["data"]["bytes"],
        json!(BASE64.encode(b"figcraft bytes"))
    );
    assert_eq!(desktop[7]["data"]["view"]["dirty"], false);
    for dir in [&tauri_dir, &web_dir] {
        assert_eq!(
            std::fs::read(dir.path().join("design.figcraft")).unwrap(),
            b"figcraft bytes"
        );
    }
}

#[tokio::test]
async fn the_persistence_routes_refuse_a_view_only_peer() {
    let app = canvas_router(CanvasState {
        pool: None,
        web_auth: None,
        boundary: None,
        write_flags: WriteFlags {
            allow_remote_writes: false,
            shared_live_writes_denied: false,
        },
    });
    for route in crate::web::canvas_persistence_api::PERSISTENCE_ROUTES {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(*route)
                    .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                        [192, 168, 1, 50],
                        40000,
                    ))))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"projectId": "p", "mountSeq": 1, "dirty": true,
                               "contentVersion": "1", "snapshot": "{}", "ack": null})
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["success"], false, "{route} must refuse a remote peer");
        assert_eq!(reply["code"], "FORBIDDEN", "{route}");
    }
}

/// The AD-31 close through either transport: a dirty mount with no editor to
/// snapshot it refuses `SAVE_FAILED` and stays, a discard unmounts it, and a
/// repeat close is a no-op.
async fn run_close<F, Fut>(project_id: &str, mount_seq: u64, call: F) -> Vec<Value>
where
    F: Fn(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let id = json!({"projectId": project_id, "mountSeq": mount_seq});
    call(
        "document-loaded",
        json!({"projectId": project_id, "mountSeq": mount_seq, "ack": "{\"contentVersion\":1}"}),
    )
    .await;
    let mounts = std::sync::Arc::clone(crate::canvas::persistence::canvas_mounts());
    let project = project_id.to_string();
    tokio::spawn(async move { mounts.dirty_changed(&project, mount_seq, true, 2).await });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let mut replies = Vec::new();
    for discard in [false, true, false] {
        let mut body = id.clone();
        body["discard"] = json!(discard);
        let mut reply = call("close", body).await;
        blank_mount_seq(&mut reply);
        replies.push(reply);
    }
    replies
}

async fn tauri_close_call(route: &'static str, body: Value) -> Value {
    if route == "close" {
        return tauri(
            canvas_close(
                body["projectId"].as_str().unwrap().to_string(),
                body["discard"].as_bool(),
            )
            .await,
        );
    }
    tauri_call(route, body).await
}

#[tokio::test]
async fn desktop_and_web_close_a_canvas_alike() {
    let tauri_dir = tempfile::tempdir().unwrap();
    let web_dir = tempfile::tempdir().unwrap();
    let tauri_seq = open("parity-close-tauri", &tauri_dir);
    let web_seq = open("parity-close-web", &web_dir);

    let desktop = run_close("parity-close-tauri", tauri_seq, tauri_close_call).await;
    let web = run_close("parity-close-web", web_seq, web_call).await;

    assert_eq!(desktop, web);
    assert_eq!(
        desktop[0]["code"], "SAVE_FAILED",
        "no editor to snapshot it"
    );
    assert_eq!(
        desktop[1]["data"],
        json!({"unmounted": true, "savedVersion": null, "discarded": true})
    );
    assert_eq!(
        desktop[2]["data"],
        json!({"unmounted": false, "savedVersion": null, "discarded": false})
    );
}
