//! Channel-carrier behavior with no `/ws` twin: the connection registry
//! (unknown / closed ids, window teardown, queue bound, stopping host) and
//! liveness without any Ping/Pong (watchdog reaping, renderer `ping` frames).
//! The shared contract runs in `harness/relay_contract_tests.rs`.

use std::time::Duration;

use serde_json::json;

use super::{ChannelError, FrameSink, CHANNEL_CLOSE_ENDED, CHANNEL_CLOSE_ENDED_REASON};
use super::INBOUND_QUEUE_CAPACITY;
use crate::web::ws::harness::wire::{authenticate, request, ChannelPeer, Wire};
use crate::web::ws::harness::{Conn, Host};
use crate::web::ws::{PONG_TIMEOUT, WS_HEARTBEAT_TYPE};

fn bare_host() -> Host {
    Host::new(|_, _| {})
}

fn discard_sink() -> FrameSink {
    std::sync::Arc::new(|_| Ok(()))
}

#[tokio::test(start_paused = true)]
async fn an_unknown_or_closed_connection_refuses_frames_and_close_is_idempotent() {
    let host = bare_host();
    let mut wire = ChannelPeer::open(&host);
    authenticate(&mut wire).await;
    let channel = wire.host().clone();
    let id = wire.connection_id();

    assert_eq!(channel.send(id + 1000, "{}".into()), Err(ChannelError::UnknownConnection));
    assert!(channel.close(id), "the first close closes");
    assert!(!channel.close(id), "a second close is a no-op");
    assert_eq!(channel.send(id, "{}".into()), Err(ChannelError::UnknownConnection));
    wire.wait_end().await;
}

#[tokio::test(start_paused = true)]
async fn the_inbound_queue_is_bounded_and_refuses_instead_of_growing() {
    let host = bare_host();
    let wire = ChannelPeer::open(&host);
    let channel = wire.host().clone();
    let id = wire.connection_id();

    // The relay has not run yet (no await since `open`): nothing is consumed.
    for _ in 0..INBOUND_QUEUE_CAPACITY {
        channel.send(id, json!({"type": "foreground"}).to_string()).expect("queued");
    }
    assert_eq!(
        channel.send(id, json!({"type": "foreground"}).to_string()),
        Err(ChannelError::QueueFull)
    );

    Conn::settle().await;
    channel
        .send(id, json!({"type": "foreground"}).to_string())
        .expect("the relay drained the queue");
}

#[tokio::test(start_paused = true)]
async fn a_destroyed_window_closes_only_its_own_connections() {
    let host = bare_host();
    let mut main = ChannelPeer::open(&host);
    authenticate(&mut main).await;
    let channel = main.host().clone();
    let other = channel.open("settings", discard_sink()).expect("opens");

    assert_eq!(channel.close_window(ChannelPeer::WINDOW), 1);
    main.wait_end().await;
    assert_eq!(channel.close_window(ChannelPeer::WINDOW), 0, "already released");
    channel
        .send(other, json!({"type": "foreground"}).to_string())
        .expect("the other window's connection is untouched");
}

#[tokio::test(start_paused = true)]
async fn a_stopping_host_takes_no_new_connection() {
    let host = bare_host();
    let channel = host.channel_host().clone();
    channel.drain().await;
    assert_eq!(channel.open("main", discard_sink()), Err(ChannelError::HostStopping));
}

/// Nothing answers a Ping on the Channel's behalf: a webview that sends no
/// frame at all is reaped by the watchdog, its subscriptions and presence are
/// released, and the host says so before the Channel ends.
#[tokio::test(start_paused = true)]
async fn a_silent_webview_is_reaped_by_the_watchdog() {
    let host = bare_host();
    let mut wire = ChannelPeer::open(&host);
    authenticate(&mut wire).await;
    assert!(host.relay.presence().device("device-harness").is_some());

    wire.read_for(PONG_TIMEOUT + Duration::from_secs(30)).await;

    assert_eq!(
        wire.wait_close().await,
        Some((CHANNEL_CLOSE_ENDED, CHANNEL_CLOSE_ENDED_REASON.to_owned()))
    );
    assert!(
        wire.events_of(WS_HEARTBEAT_TYPE).len() >= 6,
        "the host keeps heartbeating while it waits for the webview"
    );
    wire.wait_end().await;
    Conn::settle().await;
    assert!(host.relay.presence().device("device-harness").is_none());
}

/// The renderer's own `ping` requests are the liveness signal.
#[tokio::test(start_paused = true)]
async fn renderer_ping_requests_keep_a_channel_alive() {
    let host = bare_host();
    let mut wire = ChannelPeer::open(&host);
    authenticate(&mut wire).await;

    for round in 0..5 {
        wire.read_for(Duration::from_secs(30)).await;
        let reply = request(&mut wire, &format!("ping-{round}"), "ping", json!({})).await;
        assert_eq!(reply["ok"], true, "{reply}");
    }
    assert!(host.relay.presence().device("device-harness").is_some());
    assert!(wire.arrivals().iter().all(|label| label != "closed"), "never closed");
}
