//! `mark_chat_read` over the production relay loop: the shared last-read
//! marker never moves backwards, never passes the log head and never takes a
//! read from another log epoch. Its effect on other surfaces (the unread dot
//! clearing) is the `chat_activity` watch's, tested beside it.

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

async fn mark(conn: &mut Conn, id: &str, session_id: &str, seq: u64) -> Value {
    conn.request(
        id,
        "mark_chat_read",
        json!({ "sessionId": session_id, "seq": seq }),
    )
    .await
}

fn log_epoch(host: &Host) -> String {
    host.relay
        .log_head(SESSION)
        .expect("session log head")
        .log_epoch
}

#[tokio::test(start_paused = true)]
async fn a_lagging_read_never_moves_the_marker_back_or_past_the_head() {
    let host = Host::new(|_, _| {});
    emit_events(&host, 6);
    let mut reader = host.connect();
    reader.authenticate().await;

    let first = mark(&mut reader, "m1", SESSION, 5).await;
    assert_eq!(
        first["payload"],
        json!({ "sessionId": SESSION, "seq": 5, "logEpoch": log_epoch(&host) }),
        "{first}"
    );
    let lagging = mark(&mut reader, "m2", SESSION, 2).await;
    assert_eq!(lagging["ok"], true, "{lagging}");
    assert_eq!(
        lagging["payload"]["seq"], 5,
        "the marker stays where it was"
    );
    let ahead = mark(&mut reader, "m3", SESSION, 900).await;
    assert_eq!(ahead["payload"]["seq"], 6, "clamped to the log head");
    assert_eq!(
        host.relay.chat_reads().get(SESSION).map(|mark| mark.seq),
        Some(6)
    );
}

#[tokio::test(start_paused = true)]
async fn a_read_from_an_old_log_epoch_never_moves_the_marker() {
    let host = Host::new(|_, _| {});
    emit_events(&host, 6);
    let epoch = log_epoch(&host);
    let mut reader = host.connect();
    reader.authenticate().await;

    let first = reader
        .request(
            "m1",
            "mark_chat_read",
            json!({ "sessionId": SESSION, "seq": 2, "logEpoch": epoch }),
        )
        .await;
    let marker = json!({ "sessionId": SESSION, "seq": 2, "logEpoch": epoch });
    assert_eq!(first["payload"], marker, "{first}");
    let stale = reader
        .request(
            "m2",
            "mark_chat_read",
            json!({ "sessionId": SESSION, "seq": 900, "logEpoch": "an-old-epoch" }),
        )
        .await;
    assert_eq!(stale["ok"], true, "{stale}");
    assert_eq!(
        stale["payload"], marker,
        "neither moved nor clamped to the head"
    );
    assert_eq!(
        host.relay.chat_reads().get(SESSION).map(|mark| mark.seq),
        Some(2)
    );
}

#[tokio::test(start_paused = true)]
async fn an_unknown_session_or_a_malformed_payload_is_refused() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;

    let unknown = mark(&mut conn, "m1", "no-such-session", 1).await;
    assert_eq!(unknown["err"]["code"], "not_found", "{unknown}");
    let malformed = conn
        .request(
            "m2",
            "mark_chat_read",
            json!({ "sessionId": SESSION, "seq": "4" }),
        )
        .await;
    assert_eq!(malformed["err"]["code"], "unsupported", "{malformed}");
    assert_eq!(host.relay.chat_reads().get("no-such-session"), None);
    assert_eq!(host.relay.chat_reads().get(SESSION), None);
}

#[tokio::test(start_paused = true)]
async fn a_deleted_chat_loses_its_marker_on_both_delete_paths() {
    let host = Host::new(|_, _| {});
    emit_events(&host, 6);
    let mut reader = host.connect();
    reader.authenticate().await;

    mark(&mut reader, "m1", SESSION, 5).await;
    assert_eq!(
        host.relay.chat_reads().get(SESSION).map(|mark| mark.seq),
        Some(5)
    );
    host.relay.forget_chat_activity(SESSION);
    assert_eq!(host.relay.chat_reads().get(SESSION), None);

    mark(&mut reader, "m2", SESSION, 4).await;
    assert_eq!(
        host.relay.chat_reads().get(SESSION).map(|mark| mark.seq),
        Some(4)
    );
    host.relay.forget_session(SESSION).await;
    assert_eq!(host.relay.chat_reads().get(SESSION), None);
}
