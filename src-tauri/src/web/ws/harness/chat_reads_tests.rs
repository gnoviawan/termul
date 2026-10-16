//! The shared chat last-read marker over the production relay loop: a read on
//! one surface reaches the `chat_reads` watch of another, across the `/ws` and
//! desktop Channel carriers, and the marker never moves backwards.

use super::carrier::Peer;
use super::wire::{authenticate, request, ChannelPeer, Wire};
use super::*;
use crate::web::sink::{AcpEvent, EventSink};

fn emit_events(host: &Host, count: usize) {
    for _ in 0..count {
        host.relay.emit(&AcpEvent {
            sid: Some(SESSION.to_string()),
            type_: "acp:tool_call",
            payload: json!({ "sessionId": SESSION }),
        });
    }
}

fn chat_read_frames<W: Wire>(wire: &W) -> Vec<Value> {
    wire.events_of("watch")
        .into_iter()
        .filter(|frame| frame["watch"] == "chat_reads")
        .collect()
}

async fn mark<W: Wire>(wire: &mut W, id: &str, session_id: &str, seq: u64) -> Value {
    request(wire, id, "mark_chat_read", json!({ "sessionId": session_id, "seq": seq })).await
}

async fn a_read_on_one_surface_reaches_the_other<Watcher: Wire, Reader: Wire>() {
    let host = Host::new(|_, _| {});
    emit_events(&host, 5);
    let mut watcher = Watcher::open(&host);
    authenticate(&mut watcher).await;
    let mut reader = Reader::open(&host);
    authenticate(&mut reader).await;

    let reply = request(&mut watcher, "w1", "watch", json!({ "watch": "chat_reads" })).await;
    assert_eq!(reply["ok"], true, "{reply}");

    let reply = mark(&mut reader, "m1", SESSION, 4).await;
    assert_eq!(reply["payload"], json!({ "sessionId": SESSION, "seq": 4 }), "{reply}");
    watcher.read_for(Duration::from_millis(50)).await;

    let frames = chat_read_frames(&watcher);
    assert_eq!(frames.len(), 2, "state, then one delta: {frames:?}");
    assert_eq!(frames[0]["state"], json!({ "marks": {} }));
    assert_eq!(frames[1]["revision"]["n"], 2);
    assert_eq!(frames[1]["delta"], json!({ "sessionId": SESSION, "seq": 4 }));
}

#[tokio::test(start_paused = true)]
async fn a_phone_read_reaches_the_desktop_watch() {
    a_read_on_one_surface_reaches_the_other::<ChannelPeer, Peer>().await;
}

#[tokio::test(start_paused = true)]
async fn a_desktop_read_reaches_the_phone_watch() {
    a_read_on_one_surface_reaches_the_other::<Peer, ChannelPeer>().await;
}

#[tokio::test(start_paused = true)]
async fn a_lagging_read_never_moves_the_marker_back_and_a_new_watcher_gets_it() {
    let host = Host::new(|_, _| {});
    emit_events(&host, 6);
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watcher.request("w1", "watch", json!({ "watch": "chat_reads" })).await;
    let mut reader = host.connect();
    reader.authenticate().await;

    assert_eq!(mark(&mut reader.peer, "m1", SESSION, 5).await["payload"]["seq"], 5);
    let lagging = mark(&mut reader.peer, "m2", SESSION, 2).await;
    assert_eq!(lagging["ok"], true, "{lagging}");
    assert_eq!(lagging["payload"]["seq"], 5, "the marker stays where it was");
    let ahead = mark(&mut reader.peer, "m3", SESSION, 900).await;
    assert_eq!(ahead["payload"]["seq"], 6, "clamped to the log head");
    watcher.peer.read_for(Duration::from_millis(50)).await;

    let deltas: Vec<Value> = chat_read_frames(&watcher.peer)
        .into_iter()
        .filter_map(|frame| frame.get("delta").cloned())
        .collect();
    assert_eq!(
        deltas,
        vec![
            json!({ "sessionId": SESSION, "seq": 5 }),
            json!({ "sessionId": SESSION, "seq": 6 }),
        ],
        "the lagging read published nothing"
    );

    let mut late = host.connect();
    late.authenticate().await;
    late.request("w2", "watch", json!({ "watch": "chat_reads" })).await;
    let state = chat_read_frames(&late.peer);
    let marks = serde_json::Map::from_iter([(SESSION.to_string(), json!(6))]);
    assert_eq!(state[0]["state"], json!({ "marks": marks }));
}

#[tokio::test(start_paused = true)]
async fn an_unknown_session_or_a_malformed_payload_is_refused() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;

    let unknown = mark(&mut conn.peer, "m1", "no-such-session", 1).await;
    assert_eq!(unknown["err"]["code"], "not_found", "{unknown}");
    let malformed = conn
        .request("m2", "mark_chat_read", json!({ "sessionId": SESSION, "seq": "4" }))
        .await;
    assert_eq!(malformed["err"]["code"], "unsupported", "{malformed}");
    assert_eq!(host.relay.chat_reads().seq("no-such-session"), None);
    assert_eq!(host.relay.chat_reads().seq(SESSION), None);
}
