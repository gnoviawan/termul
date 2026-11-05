use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::acp::browser_policy::test_support::{fixture, fixture_with_profile, ScriptedProfile};
use crate::commands::browser_policy::{
    apply_app_policy, apply_project_policy, get_app_policy, get_project_policy,
};

const LOOPBACK: &str = "127.0.0.1:50000";
const LAN: &str = "192.168.1.9:50000";
const OPEN: WriteFlags = WriteFlags {
    allow_remote_writes: false,
    shared_live_writes_denied: false,
};

#[derive(Clone, Copy, Default)]
struct Client {
    peer: Option<&'static str>,
    bearer: bool,
}

fn router(service: Option<Arc<BrowserPolicyService>>, token_gated: bool, peer: &str) -> Router {
    router_with_flags(service, token_gated, peer, OPEN)
}

fn router_with_flags(
    service: Option<Arc<BrowserPolicyService>>,
    token_gated: bool,
    peer: &str,
    write_flags: WriteFlags,
) -> Router {
    let peer: SocketAddr = peer.parse().unwrap();
    browser_policy_router::<()>(PolicyRouteState {
        service,
        token_gated,
        write_flags,
    })
    .layer(MockConnectInfo(peer))
}

async fn send(
    router: Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    client: Client,
) -> Value {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    if client.bearer {
        request.extensions_mut().insert(BearerVerified);
    }
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(
        response.status(),
        200,
        "policy refusals are HTTP 200 envelopes"
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

enum Step {
    GetProject(&'static str),
    GetApp,
    Project {
        id: &'static str,
        revision: u64,
        op: Value,
    },
    App {
        revision: u64,
        op: Value,
    },
}

/// Run one step over the Tauri command functions.
async fn via_command(service: &BrowserPolicyService, step: &Step) -> Value {
    let caller = CallerScope::App;
    match step {
        Step::GetProject(id) => {
            serde_json::to_value(get_project_policy(service, &caller, id).await)
        }
        Step::GetApp => serde_json::to_value(get_app_policy(service, &caller).await),
        Step::Project { id, revision, op } => {
            serde_json::to_value(apply_project_policy(service, &caller, id, *revision, op).await)
        }
        Step::App { revision, op } => {
            serde_json::to_value(apply_app_policy(service, &caller, *revision, op).await)
        }
    }
    .unwrap()
}

/// Run one step over the HTTP route.
async fn via_route(service: &Arc<BrowserPolicyService>, step: &Step, client: Client) -> Value {
    let app = router(Some(service.clone()), true, client.peer.unwrap_or(LOOPBACK));
    match step {
        Step::GetProject(id) => {
            send(
                app,
                Method::GET,
                &format!("/host/browser-policy/project?projectId={id}"),
                None,
                client,
            )
            .await
        }
        Step::GetApp => send(app, Method::GET, "/host/browser-policy/app", None, client).await,
        Step::Project { id, revision, op } => {
            let body = json!({"projectId": id, "expectedRevision": revision, "op": op});
            send(
                app,
                Method::POST,
                "/host/browser-policy/project",
                Some(body),
                client,
            )
            .await
        }
        Step::App { revision, op } => {
            let body = json!({"expectedRevision": revision, "op": op});
            send(
                app,
                Method::POST,
                "/host/browser-policy/app",
                Some(body),
                client,
            )
            .await
        }
    }
}

fn admin() -> Client {
    Client {
        bearer: true,
        ..Client::default()
    }
}

#[tokio::test]
async fn the_command_and_the_route_return_identical_bodies_for_the_same_operations() {
    let command_dir = tempfile::tempdir().unwrap();
    let route_dir = tempfile::tempdir().unwrap();
    let command_side = fixture_with_profile(
        command_dir.path(),
        vec![4000],
        ScriptedProfile::succeeding(),
    );
    let route_side =
        fixture_with_profile(route_dir.path(), vec![4000], ScriptedProfile::succeeding());
    let add = |revision: u64, origin: &str| Step::Project {
        id: "p1",
        revision,
        op: json!({"op": "add_origin", "origin": origin}),
    };

    let steps = vec![
        (Step::GetApp, admin()),
        (Step::GetProject("p1"), admin()),
        (add(0, "https://Example.com:443/x"), admin()),
        (add(1, "https://*.example.org"), admin()),
        (add(1, "https://stale.example"), admin()),
        (add(2, "http://localhost:4000"), admin()),
        (add(2, "http://tauri.localhost"), admin()),
        (add(2, "not an origin"), admin()),
        (add(2, "https://*.com"), admin()),
        (
            Step::Project {
                id: "p1",
                revision: 2,
                op: json!({"op": "add_preapproval", "action": "upload", "origin": "https://example.com"}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "p1",
                revision: 3,
                op: json!({"op": "add_preapproval", "action": "navigate", "origin": "https://example.com"}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "p1",
                revision: 3,
                op: json!({"op": "set_ephemeral", "ephemeral": true}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "p1",
                revision: 4,
                op: json!({"op": "remove_preapproval", "action": "upload", "origin": "https://example.com"}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "p1",
                revision: 5,
                op: json!({"op": "remove_origin", "origin": "https://example.com"}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "p1",
                revision: 6,
                op: json!({"op": "teleport"}),
            },
            admin(),
        ),
        (
            Step::Project {
                id: "../etc",
                revision: 0,
                op: json!({"op": "set_ephemeral", "ephemeral": true}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 0,
                op: json!({"op": "set_global_profile", "enabled": false}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 0,
                op: json!({"op": "set_global_profile", "enabled": true}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 1,
                op: json!({"op": "add_preapproval", "action": "password_submit", "origin": "https://bank.example"}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 1,
                op: json!({"op": "add_preapproval", "action": "payment_submit", "origin": "https://shop.example"}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 2,
                op: json!({"op": "add_preapproval", "action": "download", "origin": "https://files.example"}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 3,
                op: json!({"op": "remove_preapproval", "action": "download", "origin": "https://files.example"}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 4,
                op: json!({"op": "set_ask_before_password_submit", "enabled": true}),
            },
            admin(),
        ),
        (
            Step::App {
                revision: 5,
                op: json!({"op": "clear_global_profile"}),
            },
            admin(),
        ),
    ];

    let mut successes = 0;
    for (index, (step, client)) in steps.iter().enumerate() {
        let from_command = via_command(&command_side.service, step).await;
        let from_route = via_route(&route_side.service, step, *client).await;
        assert_eq!(from_command, from_route, "step {index} diverged");
        successes += usize::from(from_command["success"] == true);
    }
    assert_eq!(
        successes, 14,
        "the scripted sequence mixes successes and refusals"
    );
    assert_eq!(
        command_side.sink.payloads_of("acp:browser_policy_changed"),
        route_side.sink.payloads_of("acp:browser_policy_changed")
    );
}

#[tokio::test]
async fn a_route_refusal_carries_the_reason_and_the_frozen_code() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let body = via_route(
        &f.service,
        &Step::Project {
            id: "../etc",
            revision: 0,
            op: json!({"op": "set_ephemeral", "ephemeral": true}),
        },
        admin(),
    )
    .await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "invalid_params");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .starts_with("invalid_project_id: "));
}

const SHARED_LIVE: WriteFlags = WriteFlags {
    allow_remote_writes: false,
    shared_live_writes_denied: true,
};

async fn edit_app(app: Router) -> Value {
    send(
        app,
        Method::POST,
        "/host/browser-policy/app",
        Some(json!({"expectedRevision": 0, "op": {"op": "set_global_profile", "enabled": false}})),
        admin(),
    )
    .await
}

async fn edit_project(app: Router) -> Value {
    send(
        app,
        Method::POST,
        "/host/browser-policy/project",
        Some(json!({"projectId": "p1", "expectedRevision": 0, "op": {"op": "add_origin", "origin": "https://*.evil.example"}})),
        admin(),
    )
    .await
}

#[tokio::test]
async fn policy_edits_take_the_remote_write_guard_and_reads_do_not() {
    let cases = [
        (LAN, OPEN, false),
        (LOOPBACK, SHARED_LIVE, false),
        (LAN, SHARED_LIVE, false),
        (
            LAN,
            WriteFlags {
                allow_remote_writes: true,
                shared_live_writes_denied: false,
            },
            true,
        ),
        (LOOPBACK, OPEN, true),
    ];
    for (peer, flags, admitted) in cases {
        let dir = tempfile::tempdir().unwrap();
        let f = fixture_with_profile(dir.path(), vec![], ScriptedProfile::succeeding());
        let app = || router_with_flags(Some(f.service.clone()), true, peer, flags);
        let edits = [edit_project(app()).await, edit_app(app()).await];
        let read = send(app(), Method::GET, "/host/browser-policy/app", None, admin()).await;
        let outcome = json!([
            edits[0]["code"],
            edits[1]["code"],
            read["success"],
            f.sink.payloads_of("acp:browser_policy_changed").len(),
        ]);
        let expected = if admitted {
            json!([null, null, true, 2])
        } else {
            json!(["FORBIDDEN", "FORBIDDEN", true, 0])
        };
        assert_eq!(outcome, expected, "peer={peer} flags={flags:?}");
    }
}

fn host_router(shared_live_writes_denied: bool, dir: &std::path::Path) -> Router {
    let auth = Arc::new(crate::web::auth::WebAuth::new(
        crate::web::auth::WebAuthToken::new("policy-token").unwrap(),
    ));
    crate::web::router::router_with_static(
        Arc::new(crate::acp::AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(crate::web::sink::WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir,
        false,
        shared_live_writes_denied,
        Some(auth),
        crate::web::origin::OriginPolicy::default(),
        None,
    )
}

async fn through_host(app: Router, method: Method, uri: &str, token: &str) -> (u16, Value) {
    let peer: SocketAddr = LOOPBACK.parse().unwrap();
    let body = (method == Method::POST).then(|| {
        json!({"expectedRevision": 0, "op": {"op": "set_global_profile", "enabled": false}})
            .to_string()
    });
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("host", "127.0.0.1")
        .header("authorization", format!("Bearer {token}"))
        .extension(axum::extract::ConnectInfo(peer))
        .body(body.map_or_else(Body::empty, Body::from))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Through the real host stack (bearer gate, origin and host checks): the
/// shared-live host refuses a token holder's edit before the policy service
/// is consulted, while its read and a local host's edit reach the service.
/// No service is installed in the test process, so reaching it reads
/// `capability_unavailable`.
#[tokio::test]
async fn the_shared_live_stack_refuses_policy_edits_from_a_token_holder() {
    let dir = tempfile::tempdir().unwrap();
    let app = "/host/browser-policy/app";
    let cases = [
        (true, Method::POST, "policy-token", (200, json!("FORBIDDEN"))),
        (true, Method::POST, "wrong", (401, json!("UNAUTHORIZED"))),
        (true, Method::GET, "policy-token", (200, json!("capability_unavailable"))),
        (false, Method::POST, "policy-token", (200, json!("capability_unavailable"))),
    ];
    for (shared_live, method, token, expected) in cases {
        let (status, body) =
            through_host(host_router(shared_live, dir.path()), method.clone(), app, token).await;
        assert_eq!(
            (status, body["code"].clone()),
            expected,
            "shared_live={shared_live} {method} token={token}"
        );
    }
}

#[tokio::test]
async fn a_malformed_route_body_is_a_malformed_operation_not_a_transport_error() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let app = router(Some(f.service.clone()), true, LOOPBACK);
    let body = send(
        app,
        Method::POST,
        "/host/browser-policy/app",
        Some(json!({"expectedRevision": "zero"})),
        admin(),
    )
    .await;
    assert_eq!(body["code"], "invalid_params");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .starts_with("malformed_operation: "));
}

#[tokio::test]
async fn a_gated_host_serves_only_requests_that_passed_the_token_gate() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let app = router(Some(f.service.clone()), true, LOOPBACK);
    let body = send(
        app,
        Method::GET,
        "/host/browser-policy/app",
        None,
        Client::default(),
    )
    .await;
    assert_eq!(
        (body["success"].clone(), body["code"].clone()),
        (json!(false), json!("FORBIDDEN"))
    );
}

#[tokio::test]
async fn an_ungated_host_serves_loopback_peers_only() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let local = router(Some(f.service.clone()), false, LOOPBACK);
    let ok = send(
        local,
        Method::GET,
        "/host/browser-policy/app",
        None,
        Client::default(),
    )
    .await;
    assert_eq!(ok["success"], true);

    let lan = router(Some(f.service.clone()), false, LAN);
    let refused = send(
        lan,
        Method::GET,
        "/host/browser-policy/app",
        None,
        Client::default(),
    )
    .await;
    assert_eq!(refused["code"], "FORBIDDEN");
}

#[tokio::test]
async fn a_host_without_a_policy_service_fails_closed() {
    let app = router(None, true, LOOPBACK);
    let body = send(app, Method::GET, "/host/browser-policy/app", None, admin()).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "capability_unavailable");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .starts_with("policy_store_unavailable: "));
}
