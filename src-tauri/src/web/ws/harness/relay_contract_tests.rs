//! AD-16 cross-carrier contract: every body here is written once, generic over
//! [`Wire`], and runs through BOTH the `FaultCarrier` peer (`/ws`) and the
//! desktop Channel peer, so the two carriers cannot drift apart: handshake,
//! reply-vs-echo order, request order, lost-reply recovery, host stop, hang-up
//! cleanup and unknown frames. Fault knobs (stall / drop / delay) stay
//! `FaultCarrier`-only (see `relay_fault_tests`).

use agent_client_protocol::schema::v1::StopReason;

use super::carrier::Peer;
use super::wire::{authenticate, request, send_request, ChannelPeer, Wire};
use super::*;
use crate::acp::manager::FakeTurn;
use crate::web::connection_runtime::{CLOSE_GOING_AWAY, CLOSE_REASON_HOST_STOPPING};

/// Run a `Wire`-generic body as two tests: `<name>::fault_carrier` and
/// `<name>::channel_carrier`.
macro_rules! on_both_carriers {
    ($body:ident) => {
        mod $body {
            use super::*;

            #[tokio::test(start_paused = true)]
            async fn fault_carrier() {
                super::$body::<Peer>().await;
            }

            #[tokio::test(start_paused = true)]
            async fn channel_carrier() {
                super::$body::<ChannelPeer>().await;
            }
        }
    };
}

/// A host whose agent finishes every prompt turn immediately.
fn completing_host() -> Host {
    Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            (0..4).map(|_| FakeTurn::Stop(StopReason::EndTurn)).collect(),
            false,
        );
    })
}

fn prompt_payload(turn_id: &str) -> Value {
    json!({"agentId": AGENT, "sessionId": SESSION, "text": "hello", "turnId": turn_id})
}

async fn subscribe<W: Wire>(wire: &mut W, id: &str) {
    let reply = request(wire, id, "subscribe", json!({"sessionId": SESSION})).await;
    assert_eq!(reply["ok"], true, "subscribe refused: {reply}");
}

/// The arrival log without the host's periodic liveness frames.
fn arrivals<W: Wire>(wire: &W) -> Vec<String> {
    wire.arrivals()
        .into_iter()
        .filter(|label| label != "event:heartbeat")
        .collect()
}

// ---- handshake -------------------------------------------------------------

/// `auth_required` is the first frame; without a token the versioned
/// handshake still succeeds and the connection may write; a stale protocol
/// version is refused with the stable code and stays pre-auth.
async fn handshake_without_a_token_grants_write<W: Wire>() {
    let host = completing_host();
    let mut wire = W::open(&host);
    wire.wait_event("auth_required").await;
    assert_eq!(wire.arrivals()[0], "event:auth_required");

    let early = request(&mut wire, "early", "promote_session", json!({"agentId": AGENT, "sessionId": SESSION})).await;
    assert_eq!(early["ok"], false, "pre-auth request must be refused: {early}");

    let mut stale = super::wire::authenticate_payload();
    stale["protocolVersion"] = json!(0);
    let refused = request(&mut wire, "stale", "authenticate", stale).await;
    assert_eq!(refused["err"]["code"], "protocol_version_mismatch", "{refused}");
    let still_pre_auth =
        request(&mut wire, "still", "promote_session", json!({"agentId": AGENT, "sessionId": SESSION})).await;
    assert_eq!(still_pre_auth["ok"], false, "{still_pre_auth}");

    let reply = request(&mut wire, "auth", "authenticate", super::wire::authenticate_payload()).await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["payload"]["historyMode"], "live_only", "{reply}");

    let write = request(&mut wire, "w", "promote_session", json!({"agentId": AGENT, "sessionId": SESSION})).await;
    assert_eq!(write["ok"], true, "no token, loopback peer: write capability: {write}");
    let presence = host.relay.presence().device("device-harness").expect("registered");
    assert_eq!(presence.carriers, std::collections::BTreeSet::from([W::CARRIER_LABEL]));
}
on_both_carriers!(handshake_without_a_token_grants_write);

// ---- ordering --------------------------------------------------------------

/// The `user_prompt` echo, the turn's terminator and the ok reply reach the
/// wire in one order, the same on both carriers.
async fn prompt_echo_and_reply_arrive_in_the_same_order<W: Wire>() {
    let host = completing_host();
    let mut wire = W::open(&host);
    authenticate(&mut wire).await;
    subscribe(&mut wire, "sub").await;

    let reply = request(&mut wire, "p1", "send_prompt", prompt_payload("turn-1")).await;
    assert_eq!(reply["ok"], true, "{reply}");
    wire.read_for(Duration::from_secs(1)).await;

    assert_eq!(
        arrivals(&wire),
        [
            "event:auth_required",
            "reply:auth",
            "reply:sub",
            "event:user_prompt",
            "event:prompt_complete",
            "reply:p1",
        ],
    );
}
on_both_carriers!(prompt_echo_and_reply_arrive_in_the_same_order);

/// `send_prompt` then `cancel_prompt` sent back to back on one session stay in
/// order: the cancel lands on the turn the prompt started and the held turn
/// ends `cancelled`.
async fn send_prompt_then_cancel_prompt_stay_ordered<W: Wire>() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (entered_tx, _entered_rx) = tokio::sync::oneshot::channel();
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
    let mut wire = W::open(&host);
    authenticate(&mut wire).await;
    subscribe(&mut wire, "sub").await;

    send_request(&wire, "p1", "send_prompt", prompt_payload("turn-1"));
    send_request(&wire, "c1", "cancel_prompt", json!({"agentId": AGENT, "sessionId": SESSION}));

    let cancel = tokio::time::timeout(Duration::from_secs(60), wire.wait_reply("c1"))
        .await
        .expect("cancel_prompt was never answered");
    assert_eq!(cancel["ok"], true, "{cancel}");
    let complete = tokio::time::timeout(Duration::from_secs(60), wire.wait_event("prompt_complete"))
        .await
        .expect("the cancel never reached the running turn: it overtook send_prompt");
    assert_eq!(complete["payload"]["stopReason"], "cancelled", "{complete}");
    drop(release_tx);
}
on_both_carriers!(send_prompt_then_cancel_prompt_stay_ordered);

// ---- lost reply ------------------------------------------------------------

/// The turn's final reply is lost on delivery. The client reconnects and
/// resends with the same `turnId`: the stored outcome comes back as a
/// receipt and the prompt is never run twice.
async fn a_lost_reply_is_recovered_by_a_same_turn_id_resend<W: Wire>() {
    let host = completing_host();
    let mut first = W::open(&host);
    authenticate(&mut first).await;
    subscribe(&mut first, "sub").await;

    first.lose_frames_containing("\"id\":\"p1\"");
    first.send_json(&json!({"id": "p1", "type": "send_prompt", "payload": prompt_payload("turn-1")}));
    first.wait_event("prompt_complete").await;
    first.read_for(Duration::from_secs(1)).await;
    assert!(
        !arrivals(&first).contains(&"reply:p1".to_owned()),
        "the reply was lost: {:?}",
        arrivals(&first)
    );
    first.kill();

    let mut second = W::open(&host);
    authenticate(&mut second).await;
    let sub = request(&mut second, "sub2", "subscribe", json!({"sessionId": SESSION, "lastSeq": 0})).await;
    assert_eq!(sub["ok"], true, "{sub}");
    let resend = request(&mut second, "p1-resend", "send_prompt", prompt_payload("turn-1")).await;
    assert_eq!(resend["ok"], true, "{resend}");
    assert_eq!(resend["payload"]["receipt"], "accepted", "{resend}");

    second.read_for(Duration::from_secs(1)).await;
    assert_eq!(second.events_of("user_prompt").len(), 1, "replayed once, never re-run");
    assert_eq!(second.events_of("prompt_complete").len(), 1);
}
on_both_carriers!(a_lost_reply_is_recovered_by_a_same_turn_id_resend);

// ---- close handling --------------------------------------------------------

/// A stopping host closes with `1001 host stopping` and then the wire ends.
async fn host_stop_closes_with_going_away_then_ends<W: Wire>() {
    let host = completing_host();
    let mut wire = W::open(&host);
    authenticate(&mut wire).await;

    W::stop_host(&host).await;
    assert_eq!(
        wire.wait_close().await,
        Some((CLOSE_GOING_AWAY, CLOSE_REASON_HOST_STOPPING.to_owned()))
    );
    wire.wait_end().await;
}
on_both_carriers!(host_stop_closes_with_going_away_then_ends);

/// Hanging up releases the connection's subscriptions and presence exactly
/// once: a second hang-up is harmless and a sibling connection of the same
/// device keeps its own.
async fn hanging_up_releases_subscriptions_and_presence_once<W: Wire>() {
    let host = completing_host();
    let mut leaving = W::open(&host);
    authenticate(&mut leaving).await;
    subscribe(&mut leaving, "sub").await;
    let mut staying = W::open(&host);
    authenticate(&mut staying).await;
    subscribe(&mut staying, "sub").await;
    assert_eq!(host.relay.session_subscriber_count(SESSION), 2);
    assert_eq!(host.relay.presence().device("device-harness").expect("present").connections, 2);

    leaving.hang_up();
    leaving.hang_up();
    leaving.wait_end().await;
    Conn::settle().await;

    assert_eq!(host.relay.session_subscriber_count(SESSION), 1, "released once");
    assert_eq!(host.relay.presence().device("device-harness").expect("present").connections, 1);
    let ping = request(&mut staying, "ping", "ping", json!({})).await;
    assert_eq!(ping["ok"], true, "the sibling is unaffected: {ping}");

    staying.hang_up();
    staying.wait_end().await;
    Conn::settle().await;
    assert_eq!(host.relay.session_subscriber_count(SESSION), 0);
    assert!(host.relay.presence().device("device-harness").is_none());
}
on_both_carriers!(hanging_up_releases_subscriptions_and_presence_once);

// ---- unknown frames --------------------------------------------------------

/// An unknown request type, a malformed frame and id-less lifecycle frames
/// behave as they do on `/ws`.
async fn unknown_frames_behave_as_on_ws<W: Wire>() {
    let host = completing_host();
    let mut wire = W::open(&host);
    authenticate(&mut wire).await;

    let unknown = request(&mut wire, "u1", "no_such_request", json!({})).await;
    assert_eq!(unknown["err"]["code"], "not_implemented", "{unknown}");

    wire.send_text("this is not json");
    let malformed = wire.wait_reply("malformed").await;
    assert_eq!(malformed["err"]["code"], "unsupported", "{malformed}");

    wire.send_json(&json!({"type": "background"}));
    wire.send_json(&json!({"type": "foreground"}));
    let ping = request(&mut wire, "ping", "ping", json!({})).await;
    assert_eq!(ping["ok"], true, "{ping}");
    assert_eq!(
        arrivals(&wire),
        [
            "event:auth_required",
            "reply:auth",
            "reply:u1",
            "reply:malformed",
            "reply:ping",
        ],
        "lifecycle frames are consumed without a reply"
    );
}
on_both_carriers!(unknown_frames_behave_as_on_ws);
