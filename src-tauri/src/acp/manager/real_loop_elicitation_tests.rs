//! Session-scoped URL elicitations through the production driver: a link the
//! host would not open for a remote client is cancelled before any
//! `acp:elicitation_request` event goes out.

use super::*;

const ELICITATION_REQUEST: &str = "acp:elicitation_request";

fn event_count(log: &EventLog, type_: &str) -> usize {
    log.0.lock().iter().filter(|(kind, _)| kind == type_).count()
}

fn agent_saw(events: &[(String, serde_json::Value)]) -> Option<String> {
    events.iter().find_map(|(kind, payload)| {
        (kind == "message_chunk")
            .then(|| payload["content"]["text"].as_str().map(str::to_string))
            .flatten()
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsafe_elicitation_links_are_cancelled_without_an_event() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    for (turn, url) in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "http://attacker.example/login",
    ]
    .into_iter()
    .enumerate()
    {
        let reply = h.run(&format!("elicit-url:{url}"), &format!("t{turn}")).await;
        assert_eq!(reply, Ok(StopReason::EndTurn), "{url}");
        let events = h.events_through_terminator().await;
        assert_eq!(
            agent_saw(&events).as_deref(),
            Some("elicitation cancel"),
            "{url}: {events:?}"
        );
        for log in &h.logs {
            assert_eq!(event_count(log, ELICITATION_REQUEST), 0, "{url}");
        }
    }
    h.finish().await;
}
