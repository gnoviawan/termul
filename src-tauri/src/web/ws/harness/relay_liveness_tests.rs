//! AD-19 relay-execution audit repros (AD-16 "Relay execution" cases): a
//! handler slower than the pong deadline, a stalled half-open peer, and a host
//! stop with an open socket. They fail on a relay whose read loop awaits
//! handlers, whose watchdog lives in the write arm, or whose sockets outlive
//! the host.

use tokio::sync::oneshot;

use super::raw_client::RawWsClient;
use super::*;
use crate::acp::events;
use crate::acp::manager::{FakeAuth, FakeTurn};
use crate::remote::host::{RemoteBindMode, RemoteServerState};

/// One agent text chunk fanned out like the real driver does.
pub(super) fn emit_chunk(host: &Host) {
    let event = events::MessageChunkEvent {
        agent_id: AgentId(AGENT.to_string()),
        session_id: SessionId(SESSION.to_string()),
        role: events::ChunkRole::Agent,
        content: agent_client_protocol::schema::v1::ContentBlock::Text(
            agent_client_protocol::schema::v1::TextContent::new("chunk"),
        ),
        message_id: None,
        parent_tool_call_id: None,
    };
    let sinks: Vec<Arc<dyn crate::web::EventSink>> = vec![host.relay.clone()];
    events::fan_out(&sinks, Some(SESSION), events::EVENT_MESSAGE_CHUNK, &event);
}

/// How long a half-open peer may stay unnoticed in the foreground: the pong
/// deadline plus one watchdog tick.
fn foreground_reap_by() -> Duration {
    PONG_TIMEOUT + WATCHDOG_TICK
}

/// Last instant a backgrounded half-open peer must still be held: one
/// watchdog tick short of the background ceiling.
fn background_held_until() -> Duration {
    BACKGROUND_TIMEOUT - WATCHDOG_TICK
}

/// By when a backgrounded half-open peer must be gone: the ceiling plus the
/// tick that notices it, with a second of margin.
fn background_reap_by() -> Duration {
    BACKGROUND_TIMEOUT + WATCHDOG_TICK + Duration::from_secs(1)
}

/// A streaming turn: chunks keep flowing for `total` of (virtual) time.
async fn stream_for(host: &Host, total: Duration) {
    let mut left = total;
    while !left.is_zero() {
        emit_chunk(host);
        let step = left.min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
        left -= step;
    }
}

/// A handler slower than the pong deadline must not get the connection
/// killed: the read loop never awaits a handler, so the peer's pongs keep
/// refreshing the watchdog while the request runs.
#[tokio::test(start_paused = true)]
async fn audit_long_handler_vs_ping() {
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_scripts(
            AgentId(AGENT.to_string()),
            sessions,
            Vec::new(),
            false,
            vec![FakeAuth::ok_after(foreground_reap_by() + PING_INTERVAL)],
        );
    });
    let mut conn = host.connect();
    conn.authenticate().await;

    // The peer is healthy throughout: its auto-pong answers every ping.
    conn.send_request(
        "slow",
        "authenticate_agent",
        json!({"agentId": AGENT, "methodId": "oauth"}),
    );
    conn.peer.read_for(foreground_reap_by()).await;
    assert!(
        !conn.relay_finished().await,
        "a handler slower than the pong deadline ({PONG_TIMEOUT:?}) got a healthy connection killed"
    );
    // The watchdog kept pinging throughout; the peer's pongs are what kept
    // the connection alive.
    let expected_pings = (foreground_reap_by().as_secs() / PING_INTERVAL.as_secs()) as usize - 1;
    assert!(
        conn.peer.pings_seen >= expected_pings,
        "the relay sent {} keepalive pings, expected at least {expected_pings}",
        conn.peer.pings_seen
    );

    let reply = conn.peer.wait_reply("slow").await;
    assert_eq!(reply["ok"], true, "{reply}");
}

/// A half-open peer during a streaming turn is reaped by the watchdog within
/// the pong deadline, and a backgrounded one only after the background hold,
/// even though its socket stopped draining (the write loop is stuck in a send).
#[tokio::test(start_paused = true)]
async fn audit_stale_peer_during_stream_is_reaped_by_the_watchdog() {
    let (release_tx, release_rx) = oneshot::channel();
    let (entered_tx, entered_rx) = oneshot::channel();
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            vec![FakeTurn::Hold {
                release: release_rx,
                entered: entered_tx,
            }],
            false,
        );
    });

    let mut foreground = host.connect();
    foreground.authenticate().await;
    foreground.subscribe("sub").await;
    let mut backgrounded = host.connect();
    backgrounded.authenticate().await;
    backgrounded.subscribe("sub").await;

    foreground.send_prompt_request("p1", "turn-1");
    entered_rx.await.expect("turn entered the fake agent");
    foreground.peer.wait_event("user_prompt").await;

    // Both peers go half-open mid-stream: no more pongs, and the socket stops
    // draining (a full send buffer towards a dead flow).
    backgrounded.peer.send_text(r#"{"type":"background"}"#);
    Conn::settle().await;
    for conn in [&foreground, &backgrounded] {
        conn.peer.set_auto_pong(false);
        conn.peer.stall_writes();
    }

    // Foreground: reaped within PONG_TIMEOUT plus one ping interval.
    stream_for(&host, foreground_reap_by()).await;
    assert!(
        foreground.relay_finished().await,
        "a stale foreground peer was not reaped within the pong deadline ({:?})",
        foreground_reap_by()
    );
    assert!(
        !backgrounded.relay_finished().await,
        "the {BACKGROUND_TIMEOUT:?} background hold must be honored"
    );

    // Background: still held just short of the ceiling, reaped by the first
    // tick after it.
    stream_for(&host, background_held_until() - foreground_reap_by()).await;
    assert!(
        !backgrounded.relay_finished().await,
        "the {BACKGROUND_TIMEOUT:?} background hold must be honored"
    );
    stream_for(&host, background_reap_by() - background_held_until()).await;
    assert!(
        backgrounded.relay_finished().await,
        "a stale backgrounded peer was not reaped after the {BACKGROUND_TIMEOUT:?} hold"
    );
    drop(release_tx);
}

/// A started shared-live host on an OS-assigned port, with its scratch dirs.
struct StartedHost {
    host: RemoteServerState,
    addr: std::net::SocketAddr,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn start_host() -> StartedHost {
    let acp = Arc::new(AcpManager::new(vec![]));
    let pty = crate::web::test_pty_manager();
    let relay = Arc::new(WsRelaySink::new());
    // Root the host in a scratch directory: with an empty registry it falls
    // back to `$HOME`, whose recursive scan can take minutes on a large tree.
    let root = tempfile::tempdir().expect("scratch project root");
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-harness".to_string(),
            name: "harness".to_string(),
            color: "blue".to_string(),
            path: Some(root.path().to_string_lossy().into_owned()),
            is_archived: false,
            is_default: true,
        }],
        Some("p-harness".to_string()),
    );
    let data_dir = tempfile::tempdir().expect("scratch data dir");
    let data = crate::remote::host::SharedLiveData {
        store: Arc::new(
            crate::web::store::WebStore::open(
                data_dir.path().join("store.json"),
                crate::web::store::StorePolicy::default(),
            )
            .expect("open the scratch store"),
        ),
        data_dir: data_dir.path().to_path_buf(),
    };
    let host = RemoteServerState::new();
    let status = host
        .start(
            acp,
            pty,
            relay,
            registry,
            RemoteBindMode::Localhost,
            false,
            &data,
            None,
            None,
        )
        .await
        .expect("host starts on an OS-assigned port");
    let addr = ([127, 0, 0, 1], status.port.expect("bound port")).into();
    StartedHost {
        host,
        addr,
        _dirs: (root, data_dir),
    }
}

/// Stop `started` and require the open `client` to get `Close(1001)` and then
/// EOF: the upgraded task finished instead of lingering.
async fn assert_stop_closes_with_1001(started: &StartedHost, client: &mut RawWsClient) {
    tokio::time::timeout(Duration::from_secs(10), started.host.stop())
        .await
        .expect("stop must not hang on an open socket")
        .expect("stop succeeds");

    // The close arrives promptly, then the host drops the socket: EOF with no
    // further frame proves the upgraded task finished instead of lingering.
    let close = client
        .close_code_within(Duration::from_millis(500))
        .await
        .expect("the host stopped but the open socket was never closed");
    assert_eq!(close, Some(1001), "Close(1001 host stopping) expected");
    let eof = tokio::time::timeout(Duration::from_millis(500), client.read_frame())
        .await
        .expect("the upgraded socket stayed open after its Close frame");
    assert!(eof.is_none(), "unexpected frame after Close: {eof:?}");
}

/// Stopping the host sends `Close(1001)` to an open socket and the upgraded
/// task ends with it: after the `Close` the socket reaches EOF (the host
/// dropped it), so `kill_all` / process exit never races a live relay.
#[tokio::test]
async fn audit_stop_with_open_socket_sends_close_1001_and_drains() {
    let started = start_host().await;
    let mut client = RawWsClient::connect(started.addr, "/ws").await;
    let first = client
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("auth_required event not delivered in time")
        .expect("auth_required event");
    assert_eq!(first["type"], "auth_required", "{first}");

    assert_stop_closes_with_1001(&started, &mut client).await;
}

/// The same through the real `/terminal/ws` upgrade handler (its shutdown
/// lease, `serve_socket` and the host's drain), with `/ws` open alongside.
#[tokio::test]
async fn stop_with_an_open_terminal_socket_sends_close_1001() {
    let started = start_host().await;
    let mut terminal = RawWsClient::connect(started.addr, "/terminal/ws").await;
    let mut relay = RawWsClient::connect(started.addr, "/ws").await;
    relay
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("/ws auth_required")
        .expect("/ws auth_required");

    assert_stop_closes_with_1001(&started, &mut terminal).await;
    // `/ws` got its close from the same stop (already delivered by now).
    let close = relay
        .close_code_within(Duration::from_millis(500))
        .await
        .expect("the /ws socket was not closed by the same stop");
    assert_eq!(close, Some(1001));
}

const OVERSIZE_TEXT_BYTES: usize = 20 * 1024 * 1024;

/// `/ws` takes no frame past tungstenite's 16 MiB default from a peer that
/// has not authenticated: the read fails and the connection ends, instead of
/// the host buffering up to the canvas reply cap for anyone who connects.
#[tokio::test]
async fn an_unauthenticated_frame_past_the_default_limit_ends_the_connection() {
    let started = start_host().await;
    let mut client = RawWsClient::connect(started.addr, "/ws").await;
    client
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("auth_required event not delivered in time")
        .expect("auth_required event");

    let pad = "a".repeat(OVERSIZE_TEXT_BYTES);
    // The host may close before it has read the whole frame.
    let _ = client
        .send_text(
            &json!({ "id": "big", "type": "authenticate", "payload": { "pad": pad } }).to_string(),
        )
        .await;

    loop {
        let frame = client
            .read_json_within(Duration::from_secs(30))
            .await
            .expect("the socket stayed open after an oversize frame");
        let Some(frame) = frame else { break };
        assert_ne!(
            frame["id"], "big",
            "the oversize frame was answered: {frame}"
        );
    }

    started.host.stop().await.expect("stop succeeds");
}

/// An export larger than one frame still reaches the call: an authenticated
/// renderer sends the reply as slices, the host joins them, and the socket
/// stays open for the next message.
#[tokio::test]
async fn an_authenticated_renderer_can_answer_a_canvas_call_with_a_reply_past_the_frame_limit() {
    let host = Host::new(|_, _| {});
    host.state
        .acp
        .canvas_router()
        .mounts()
        .ensure_test_mount("p-canvas", 1);
    let addr = serve_ws(&host).await;
    let mut client = RawWsClient::connect(addr, "/ws").await;
    client
        .read_json_within(Duration::from_secs(5))
        .await
        .expect("auth_required event not delivered in time")
        .expect("auth_required event");

    send_request(
        &mut client,
        "auth",
        "authenticate",
        json!({
            "protocolVersion": WS_PROTOCOL_VERSION,
            "deviceId": "device-harness",
            "clientInstanceId": crate::canvas::persistence::TEST_RENDERER,
        }),
    )
    .await;
    let authed = wait_reply(&mut client, "auth").await;
    assert_eq!(authed["ok"], true, "{authed}");
    send_request(
        &mut client,
        "mount",
        "canvas_mount",
        json!({ "projectId": "p-canvas", "mountSeq": 1 }),
    )
    .await;
    let mounted = wait_reply(&mut client, "mount").await;
    assert_eq!(mounted["payload"]["attached"], true, "{mounted}");

    let call = tokio::spawn({
        let acp = Arc::clone(&host.state.acp);
        async move {
            acp.canvas_router()
                .call("p-canvas", "export.png", "{}".into())
                .await
        }
    });
    let call_id = loop {
        let frame = client
            .read_json_within(Duration::from_secs(5))
            .await
            .expect("no canvas_call frame in time")
            .expect("the socket closed before the call arrived");
        if frame["type"] == "canvas_call" {
            break frame["callId"].as_u64().expect("callId");
        }
    };

    let result = "a".repeat(OVERSIZE_TEXT_BYTES);
    let slice_len = 8 * 1024 * 1024;
    let slices: Vec<&[u8]> = result.as_bytes().chunks(slice_len).collect();
    for (index, slice) in slices.iter().enumerate() {
        let last = index + 1 == slices.len();
        let id = format!("slice-{index}");
        let mut payload = json!({
            "callId": call_id,
            "mountSeq": 1,
            "ok": true,
            "result": std::str::from_utf8(slice).expect("ascii"),
        });
        if !last {
            payload["partial"] = json!(true);
        }
        send_request(&mut client, &id, "canvas_reply", payload).await;
        let reply = wait_reply(&mut client, &id).await;
        let key = if last { "resolved" } else { "accepted" };
        assert_eq!(reply["payload"][key], true, "{reply}");
    }

    assert_eq!(call.await.expect("call task"), Ok(result));
}

async fn send_request(client: &mut RawWsClient, id: &str, type_: &str, payload: Value) {
    client
        .send_text(&json!({ "id": id, "type": type_, "payload": payload }).to_string())
        .await
        .expect("the host closed the socket on a request");
}

async fn wait_reply(client: &mut RawWsClient, id: &str) -> Value {
    loop {
        let frame = client
            .read_json_within(Duration::from_secs(30))
            .await
            .unwrap_or_else(|()| panic!("no reply to {id} in time"))
            .unwrap_or_else(|| panic!("the socket closed before the reply to {id}"));
        if frame["id"] == id {
            return frame;
        }
    }
}

/// The real `/ws` upgrade handler over a loopback listener, for a host's
/// state: a local, write-capable peer on an OS-assigned port.
async fn serve_ws(host: &Host) -> std::net::SocketAddr {
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(crate::web::ws::ws_upgrade))
        .with_state(host.state.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind a loopback port");
    let addr = listener.local_addr().expect("bound address");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
    });
    addr
}
