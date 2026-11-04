//! The `chat_activity` watch over the production relay loop: a connection that
//! never subscribed to a session still learns, from the host, whether the
//! session is working, needs the user, or has a turn end nobody has read.
//! Chat lists on every surface read this record, so a chat the phone has not
//! opened shows the same status as the one the desktop is driving.

use agent_client_protocol::schema::v1::StopReason;
use tokio::sync::oneshot;

use super::carrier::Peer;
use super::wire::{authenticate, request, ChannelPeer, Wire};
use super::*;
use crate::acp::manager::FakeTurn;
use crate::web::permissions::{PermissionRendezvous, QuestionRendezvous};
use crate::web::sink::{AcpEvent, EventSink};

fn hold_host() -> (Host, oneshot::Sender<()>, oneshot::Receiver<()>) {
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
    (host, release_tx, entered_rx)
}

fn ticket_host() -> Host {
    let host = Host::new(|_, _| {});
    let acp = Arc::clone(&host.state.acp);
    host.relay
        .set_rendezvous(Arc::new(PermissionRendezvous::new(Arc::clone(&acp))));
    host.relay
        .set_question_rendezvous(Arc::new(QuestionRendezvous::new(acp)));
    host
}

fn emit(host: &Host, sid: Option<&str>, type_: &'static str, payload: Value) {
    host.relay.emit(&AcpEvent {
        sid: sid.map(str::to_string),
        type_,
        payload,
    });
}

async fn watch_activity<W: Wire>(wire: &mut W) {
    let reply = request(
        wire,
        "watch-activity",
        "watch",
        json!({ "watch": "chat_activity" }),
    )
    .await;
    assert_eq!(reply["ok"], true, "{reply}");
}

/// What a client holds after applying the watch frames in order: the state,
/// then each delta (a session's record as it stands; an idle record with no
/// turn end leaves the map).
fn activity<W: Wire>(wire: &W) -> serde_json::Map<String, Value> {
    let mut sessions = serde_json::Map::new();
    for frame in wire
        .events_of("watch")
        .into_iter()
        .filter(|frame| frame["watch"] == "chat_activity")
    {
        if let Some(state) = frame.get("state") {
            sessions = state["sessions"].as_object().cloned().unwrap_or_default();
        }
        if let Some(delta) = frame.get("delta") {
            let session_id = delta["sessionId"]
                .as_str()
                .expect("delta sessionId")
                .to_string();
            let mut record = delta.as_object().cloned().expect("delta object");
            record.remove("sessionId");
            let idle = record["busy"] == false
                && record["needsYou"] == false
                && record["unread"] == false
                && record["turnEnd"].is_null();
            if idle {
                sessions.remove(&session_id);
            } else {
                sessions.insert(session_id, Value::Object(record));
            }
        }
    }
    sessions
}

fn record(busy: bool, needs_you: bool, unread: bool, turn_end: Value) -> Value {
    json!({ "busy": busy, "needsYou": needs_you, "unread": unread, "turnEnd": turn_end })
}

fn log_epoch(host: &Host) -> String {
    host.relay
        .log_head(SESSION)
        .expect("session log head")
        .log_epoch
}

/// The phone (or desktop) never subscribed to the session another surface is
/// prompting, yet it sees the turn open, end unread, and clear once read.
async fn an_unsubscribed_watcher_follows_the_turn<W: Wire>() {
    let (host, release, entered) = hold_host();
    let mut watcher = W::open(&host);
    authenticate(&mut watcher).await;
    watch_activity(&mut watcher).await;
    assert_eq!(
        activity(&watcher),
        serde_json::Map::new(),
        "nothing works yet"
    );

    let mut prompter = host.connect();
    prompter.authenticate().await;
    prompter.subscribe("sub").await;
    prompter.send_prompt_request("p1", "turn-1");
    entered.await.expect("turn entered the fake agent");
    watcher.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher).get(SESSION),
        Some(&record(true, false, false, Value::Null)),
        "the open turn reaches a connection with no subscription"
    );

    release.send(()).expect("release the held turn");
    let complete = prompter.peer.wait_event("prompt_complete").await;
    let turn_end = json!({ "seq": complete["seq"], "logEpoch": log_epoch(&host) });
    watcher.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher).get(SESSION),
        Some(&record(false, false, true, turn_end.clone())),
        "the finished turn is new activity nobody has read"
    );

    let read = request(
        &mut watcher,
        "read",
        "mark_chat_read",
        json!({ "sessionId": SESSION, "seq": turn_end["seq"], "logEpoch": turn_end["logEpoch"] }),
    )
    .await;
    assert_eq!(read["ok"], true, "{read}");
    watcher.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher).get(SESSION),
        Some(&record(false, false, false, turn_end.clone())),
        "reading the turn end clears the dot on every watcher"
    );

    let mut late = W::open(&host);
    authenticate(&mut late).await;
    watch_activity(&mut late).await;
    assert_eq!(
        activity(&late).get(SESSION),
        Some(&record(false, false, false, turn_end)),
        "a new watcher gets the record in its first state"
    );
    let reply = prompter.peer.wait_reply("p1").await;
    assert_eq!(reply["payload"], json!(StopReason::EndTurn), "{reply}");
}

on_both_carriers!(an_unsubscribed_watcher_follows_the_turn);

#[tokio::test(start_paused = true)]
async fn a_pending_permission_or_question_needs_you_until_answered() {
    let host = ticket_host();
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watch_activity(&mut watcher.peer).await;
    let mut answerer = host.connect();
    answerer.authenticate().await;

    emit(
        &host,
        Some(SESSION),
        "acp:permission_request",
        json!({
            "agentId": AGENT, "sessionId": SESSION, "requestId": "perm-1",
            "toolCall": {"toolCallId": "tc-1"}, "options": [{"optionId": "allow"}],
        }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION),
        Some(&record(false, true, false, Value::Null))
    );

    let answered = answerer
        .request(
            "r1",
            "respond_permission",
            json!({"requestId": "perm-1", "optionId": "allow"}),
        )
        .await;
    assert_eq!(answered["ok"], true, "{answered}");
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION),
        None,
        "answered: nothing left to show"
    );

    emit(
        &host,
        Some(SESSION),
        "acp:question_request",
        json!({
            "agentId": AGENT, "sessionId": SESSION, "questionId": "q-1",
            "options": [{"value": "plan-a", "label": "plan-a"}],
        }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION),
        Some(&record(false, true, false, Value::Null))
    );

    let answered = answerer
        .request(
            "q1",
            "answer_question",
            json!({"questionId": "q-1", "values": ["plan-a"]}),
        )
        .await;
    assert_eq!(answered["ok"], true, "{answered}");
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(activity(&watcher.peer).get(SESSION), None);
}

#[tokio::test(start_paused = true)]
async fn an_elicitation_needs_you_until_its_turn_ends() {
    let host = ticket_host();
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watch_activity(&mut watcher.peer).await;

    emit(
        &host,
        Some(SESSION),
        "acp:elicitation_request",
        json!({ "agentId": AGENT, "sessionId": SESSION, "requestId": "elicit-1" }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION).map(|r| &r["needsYou"]),
        Some(&json!(true))
    );

    emit(
        &host,
        Some(SESSION),
        "acp:prompt_complete",
        json!({ "agentId": AGENT, "sessionId": SESSION, "turnId": "turn-1", "stopReason": "cancelled" }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    let state = activity(&watcher.peer);
    assert_eq!(
        state.get(SESSION).map(|r| &r["needsYou"]),
        Some(&json!(false))
    );
    assert_eq!(state.get(SESSION).map(|r| &r["unread"]), Some(&json!(true)));
}

#[tokio::test(start_paused = true)]
async fn work_outside_a_turn_is_busy_until_the_agent_stops_or_dies() {
    let host = Host::new(|_, _| {});
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watch_activity(&mut watcher.peer).await;
    let working =
        |working: bool| json!({ "agentId": AGENT, "sessionId": SESSION, "working": working });

    emit(&host, Some(SESSION), "acp:agent_working", working(true));
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION),
        Some(&record(true, false, false, Value::Null))
    );

    emit(&host, Some(SESSION), "acp:agent_working", working(false));
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(activity(&watcher.peer).get(SESSION), None);

    emit(&host, Some(SESSION), "acp:agent_working", working(true));
    emit(
        &host,
        None,
        "acp:agent_crashed",
        json!({ "agentId": AGENT }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        activity(&watcher.peer).get(SESSION),
        None,
        "a dead agent works on nothing"
    );
}

#[tokio::test(start_paused = true)]
async fn a_closed_session_stops_working_and_a_deleted_one_leaves_the_list() {
    let host = Host::new(|_, _| {});
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watch_activity(&mut watcher.peer).await;

    emit(
        &host,
        Some(SESSION),
        "acp:agent_working",
        json!({ "agentId": AGENT, "sessionId": SESSION, "working": true }),
    );
    emit(
        &host,
        Some(SESSION),
        "acp:prompt_complete",
        json!({ "agentId": AGENT, "sessionId": SESSION, "stopReason": "end_turn" }),
    );
    emit(
        &host,
        Some(SESSION),
        "acp:session_closed",
        json!({ "agentId": AGENT, "sessionId": SESSION }),
    );
    watcher.peer.read_for(Duration::from_millis(50)).await;
    let closed = activity(&watcher.peer);
    assert_eq!(closed.get(SESSION).map(|r| &r["busy"]), Some(&json!(false)));
    assert_eq!(
        closed.get(SESSION).map(|r| &r["unread"]),
        Some(&json!(true)),
        "a stopped chat keeps its dot"
    );

    host.relay.forget_session(SESSION).await;
    watcher.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(activity(&watcher.peer).get(SESSION), None);
}
