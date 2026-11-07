//! The canvas gateway's renderer leg through the production relay on both
//! carriers: a browser socket and the desktop Channel. Each body runs once
//! per carrier, so an agent call reaches a browser lease holder exactly as it
//! reaches a desktop window: the same `canvas_call` envelope, the same
//! re-attach after a reconnect inside the lease grace (AD-30), calls held
//! through that reconnect, the same `CANVAS_CLOSED` once the grace runs out,
//! and the same timeout (AD-29).

use super::carrier::Peer;
use super::wire::{request, ChannelPeer, Wire};
use super::*;
use crate::acp::host_mcp::canvas::{CanvasErrorCode, CanvasOutcome};
use crate::canvas::persistence::{
    MountRequest, RendererId, DEFAULT_CRASH_TIMEOUTS, DEFAULT_MAX_MOUNTED,
};

const PROJECT: &str = "proj-gateway";
const GRACE: Duration = Duration::from_secs(5);
const U64_ID: &str = r#"{"id":18446744073709551615}"#;

fn host() -> Host {
    Host::new(|_, _| {})
}

/// A connection authenticated as the window or tab `tab`.
async fn renderer<W: Wire>(host: &Host, tab: &str) -> W {
    let mut wire = W::open(host);
    let reply = request(
        &mut wire,
        "auth",
        "authenticate",
        json!({
            "protocolVersion": WS_PROTOCOL_VERSION,
            "deviceId": "device-gateway",
            "clientInstanceId": tab,
        }),
    )
    .await;
    assert_eq!(reply["ok"], true, "handshake refused: {reply}");
    wire
}

/// `tab` opens the project's canvas and gets its lease: the new `mountSeq`.
async fn open(host: &Host, doc: &tempfile::TempDir, tab: &str) -> u64 {
    host.state
        .acp
        .canvas_router()
        .mounts()
        .open(
            PROJECT,
            MountRequest {
                renderer: RendererId::new(tab),
                doc_path: doc.path().join("design.figcraft"),
                autosave: Duration::from_secs(60),
                autosave_max: crate::canvas::persistence::autosave_max_wait(None),
                lease_grace: GRACE,
                crash_timeouts: DEFAULT_CRASH_TIMEOUTS,
            },
            DEFAULT_MAX_MOUNTED,
        )
        .await
        .opened
        .expect("the open is granted")
        .mount_seq
}

async fn report_mount<W: Wire>(wire: &mut W, id: &str, mount_seq: u64) -> Value {
    let reply = request(
        wire,
        id,
        "canvas_mount",
        json!({ "projectId": PROJECT, "mountSeq": mount_seq }),
    )
    .await;
    assert_eq!(reply["ok"], true, "{reply}");
    reply["payload"].clone()
}

/// An agent's tool call, forwarded by the router on its own task.
fn agent_call(host: &Host, method: &'static str) -> tokio::task::JoinHandle<CanvasOutcome> {
    let router = host.state.acp.canvas_router();
    tokio::spawn(async move { router.call(PROJECT, method, U64_ID.into()).await })
}

/// The next `canvas_call` frame on `wire`, whole.
async fn next_call<W: Wire>(wire: &mut W, seen: usize) -> Value {
    for _ in 0..100 {
        if let Some(call) = wire.events_of("canvas_call").get(seen) {
            return call.clone();
        }
        wire.read_for(Duration::from_millis(10)).await;
    }
    panic!("no canvas_call frame arrived");
}

async fn answer<W: Wire>(wire: &mut W, id: &str, frame: &Value, result: &str) {
    let reply = request(
        wire,
        id,
        "canvas_reply",
        json!({ "callId": frame["callId"], "mountSeq": frame["mountSeq"], "ok": true, "result": result }),
    )
    .await;
    assert_eq!(reply["payload"], json!({ "resolved": true }), "{reply}");
}

/// The envelope a renderer receives and the reply that answers the agent.
async fn a_gateway_call_reaches_the_holder_and_its_reply_answers_the_agent<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut tab = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut tab, "m1", seq).await,
        json!({ "attached": true })
    );

    let call = agent_call(&host, "node.get");
    let frame = next_call(&mut tab, 0).await;
    assert_eq!(
        frame,
        json!({
            "type": "canvas_call",
            "callId": frame["callId"],
            "projectId": PROJECT,
            "mountSeq": seq,
            "method": "node.get",
            "params": U64_ID,
            "timeoutMs": frame["timeoutMs"],
        })
    );
    assert!(frame["callId"].as_u64().is_some(), "{frame}");
    assert!(
        frame["timeoutMs"].as_u64().is_some_and(|left| left > 0),
        "the renderer is told how long the host still waits: {frame}"
    );
    answer(&mut tab, "r1", &frame, U64_ID).await;
    assert_eq!(call.await.unwrap(), Ok(U64_ID.to_string()));
}
on_both_carriers!(a_gateway_call_reaches_the_holder_and_its_reply_answers_the_agent);

/// A dropped socket that comes back inside the grace (the transport re-reports
/// its mount on every connect) takes the agent's calls again.
async fn a_holder_back_within_the_grace_takes_its_calls_again<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut first = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut first, "m1", seq).await,
        json!({ "attached": true })
    );
    first.hang_up();
    first.wait_end().await;

    tokio::time::sleep(GRACE / 2).await;
    let mut again = renderer::<W>(&host, "tab-a").await;
    assert_eq!(
        report_mount(&mut again, "m2", seq).await,
        json!({ "attached": true })
    );
    tokio::time::sleep(GRACE).await;

    let call = agent_call(&host, "document.inspect");
    let frame = next_call(&mut again, 0).await;
    assert_eq!(frame["mountSeq"], seq);
    answer(&mut again, "r1", &frame, "{}").await;
    assert_eq!(call.await.unwrap(), Ok("{}".to_string()));
}
on_both_carriers!(a_holder_back_within_the_grace_takes_its_calls_again);

/// Once the grace runs out the mount is gone: calls answer `CANVAS_CLOSED`
/// and a late re-report is refused.
async fn a_holder_gone_past_the_grace_leaves_calls_closed<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut first = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut first, "m1", seq).await,
        json!({ "attached": true })
    );
    first.hang_up();
    first.wait_end().await;

    tokio::time::sleep(GRACE + Duration::from_millis(100)).await;
    let closed = agent_call(&host, "node.get").await.unwrap().unwrap_err();
    assert_eq!(
        closed.code,
        CanvasErrorCode::CanvasClosed,
        "{}",
        closed.message
    );

    let mut late = renderer::<W>(&host, "tab-a").await;
    assert_eq!(
        report_mount(&mut late, "m2", seq).await,
        json!({ "attached": false, "heldElsewhere": false })
    );
}
on_both_carriers!(a_holder_gone_past_the_grace_leaves_calls_closed);

/// An agent call that arrives while the holder reconnects, inside the
/// grace, waits for the holder to attach again and is answered there.
async fn a_call_during_a_reconnect_waits_for_the_holder<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut first = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut first, "m1", seq).await,
        json!({ "attached": true })
    );
    first.hang_up();
    first.wait_end().await;

    let call = agent_call(&host, "node.get");
    tokio::time::sleep(GRACE / 2).await;
    assert!(!call.is_finished(), "the call waits for the holder");
    let mut again = renderer::<W>(&host, "tab-a").await;
    assert_eq!(
        report_mount(&mut again, "m2", seq).await,
        json!({ "attached": true })
    );
    let frame = next_call(&mut again, 0).await;
    assert_eq!(frame["mountSeq"], seq);
    answer(&mut again, "r1", &frame, U64_ID).await;
    assert_eq!(call.await.unwrap(), Ok(U64_ID.to_string()));
}
on_both_carriers!(a_call_during_a_reconnect_waits_for_the_holder);

/// A holder that never comes back: the waiting call answers `CANVAS_CLOSED`
/// when the grace runs out, not before.
async fn a_call_waiting_for_a_holder_that_never_returns_closes_with_the_grace<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut first = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut first, "m1", seq).await,
        json!({ "attached": true })
    );
    first.hang_up();
    first.wait_end().await;
    let lost_at = tokio::time::Instant::now();

    let closed = agent_call(&host, "node.get").await.unwrap().unwrap_err();
    assert_eq!(
        closed.code,
        CanvasErrorCode::CanvasClosed,
        "{}",
        closed.message
    );
    assert!(
        lost_at.elapsed() >= GRACE,
        "answered after {:?}",
        lost_at.elapsed()
    );
}
on_both_carriers!(a_call_waiting_for_a_holder_that_never_returns_closes_with_the_grace);

/// The call timeout still bounds a call that waits for a reconnect.
async fn a_call_waiting_for_a_reconnect_times_out_at_the_call_timeout<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut first = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut first, "m1", seq).await,
        json!({ "attached": true })
    );
    let timeout = Duration::from_millis(500);
    host.state.acp.canvas_router().set_call_timeout(timeout);
    first.hang_up();
    first.wait_end().await;
    let asked_at = tokio::time::Instant::now();

    let timed_out = agent_call(&host, "node.get").await.unwrap().unwrap_err();
    assert_eq!(
        timed_out.code,
        CanvasErrorCode::CanvasTimeout,
        "{}",
        timed_out.message
    );
    assert!(
        asked_at.elapsed() < GRACE,
        "answered after {:?}",
        asked_at.elapsed()
    );
}
on_both_carriers!(a_call_waiting_for_a_reconnect_times_out_at_the_call_timeout);

/// The router is the only place a call times out, whatever the carrier.
async fn a_call_the_holder_never_answers_times_out<W: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut tab = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    assert_eq!(
        report_mount(&mut tab, "m1", seq).await,
        json!({ "attached": true })
    );
    host.state
        .acp
        .canvas_router()
        .set_call_timeout(Duration::from_millis(500));

    let call = agent_call(&host, "node.get");
    next_call(&mut tab, 0).await;
    let timed_out = call.await.unwrap().unwrap_err();
    assert_eq!(
        timed_out.code,
        CanvasErrorCode::CanvasTimeout,
        "{}",
        timed_out.message
    );
}
on_both_carriers!(a_call_the_holder_never_answers_times_out);

/// A desktop window and a browser hand one canvas back and forth (AD-30):
/// the newest opener holds the lease, the other is told, and agent calls
/// follow the lease across carriers.
async fn takeover_across_carriers<Before: Wire, After: Wire>() {
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut before = renderer::<Before>(&host, "window-before").await;
    let mut after = renderer::<After>(&host, "window-after").await;
    let first = open(&host, &doc, "window-before").await;
    assert_eq!(
        report_mount(&mut before, "m1", first).await,
        json!({ "attached": true })
    );

    let second = open(&host, &doc, "window-after").await;
    let notice = before.wait_event("canvas_lease_lost").await;
    assert_eq!(
        notice,
        json!({
            "type": "canvas_lease_lost",
            "projectId": PROJECT,
            "mountSeq": first,
            "reason": "takenOver",
        })
    );
    assert_eq!(
        report_mount(&mut after, "m2", second).await,
        json!({ "attached": true })
    );

    let call = agent_call(&host, "node.get");
    let frame = next_call(&mut after, 0).await;
    assert_eq!(frame["mountSeq"], second);
    answer(&mut after, "r1", &frame, U64_ID).await;
    assert_eq!(call.await.unwrap(), Ok(U64_ID.to_string()));
    assert!(
        before.events_of("canvas_call").is_empty(),
        "the old holder gets no call"
    );
}

#[tokio::test(start_paused = true)]
async fn a_browser_takes_the_canvas_from_a_desktop_window() {
    takeover_across_carriers::<ChannelPeer, Peer>().await;
}

#[tokio::test(start_paused = true)]
async fn a_desktop_window_takes_the_canvas_from_a_browser() {
    takeover_across_carriers::<Peer, ChannelPeer>().await;
}

/// The params of a host presence notice or lookup, after checking it is a
/// plain `canvas_call` envelope for the holder's mount (a lookup also says
/// how long the host waits for it).
fn presence_params(frame: &Value, mount_seq: u64, method: &str) -> Value {
    let mut envelope = frame.clone();
    envelope.as_object_mut().unwrap().remove("timeoutMs");
    assert_eq!(
        envelope,
        json!({
            "type": "canvas_call",
            "callId": frame["callId"],
            "projectId": PROJECT,
            "mountSeq": mount_seq,
            "method": method,
            "params": frame["params"],
        })
    );
    serde_json::from_str(frame["params"].as_str().expect("params are JSON text")).unwrap()
}

/// An answered agent call shows on the holder's canvas as the session's
/// guest: one bounds lookup, then the cursor and the ring, and the hide when
/// the turn ends. Same envelopes on both carriers.
async fn an_answered_agent_call_shows_as_a_guest_on_the_holders_canvas<W: Wire>() {
    use crate::acp::host_mcp::presence::{
        colour_of, CallOrigin, Presence, GUEST_CURSOR, GUEST_FLASH, GUEST_HIDE,
    };
    let host = host();
    let doc = tempfile::tempdir().unwrap();
    let mut tab = renderer::<W>(&host, "tab-a").await;
    let seq = open(&host, &doc, "tab-a").await;
    report_mount(&mut tab, "m1", seq).await;
    let presence = Presence::new(std::sync::Arc::clone(
        host.state.acp.canvas_router().mounts(),
    ));
    presence.name_agent("agent-a", "opencode");
    let origin = CallOrigin {
        session_id: "sess-a",
        agent_id: "agent-a",
        project_id: PROJECT,
    };
    presence.after_call(
        origin,
        "create_node",
        "engine.execute",
        &json!({ "command": "node.create", "params": { "type": "frame" } }),
        U64_ID,
    );

    let lookup = next_call(&mut tab, 0).await;
    assert_eq!(
        presence_params(&lookup, seq, "node.get"),
        json!({ "id": u64::MAX, "depth": 0 })
    );
    answer(
        &mut tab,
        "r1",
        &lookup,
        r#"{"id":18446744073709551615,"absoluteBounds":{"x":0,"y":10,"width":40,"height":20}}"#,
    )
    .await;
    let cursor = next_call(&mut tab, 1).await;
    assert_eq!(
        presence_params(&cursor, seq, GUEST_CURSOR),
        json!({ "id": "sess-a", "name": "opencode", "color": colour_of("sess-a"), "x": 20.0, "y": 20.0 })
    );
    let flash = next_call(&mut tab, 2).await;
    assert!(flash["params"]
        .as_str()
        .unwrap()
        .contains("18446744073709551615"));
    assert_eq!(
        presence_params(&flash, seq, GUEST_FLASH),
        json!({ "id": "sess-a", "ids": [u64::MAX], "kind": "write" })
    );

    presence.hide("sess-a");
    let hide = next_call(&mut tab, 3).await;
    assert_eq!(
        presence_params(&hide, seq, GUEST_HIDE),
        json!({ "id": "sess-a" })
    );
}
on_both_carriers!(an_answered_agent_call_shows_as_a_guest_on_the_holders_canvas);
