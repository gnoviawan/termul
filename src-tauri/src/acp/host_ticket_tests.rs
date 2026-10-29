#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::browser_automation::core::ports::{CanonicalOrigin, TicketFile};
use crate::web::sink::{AcpEvent, WsRelaySink};

#[derive(Default)]
struct Recorder(Mutex<Vec<(Option<String>, &'static str, Value)>>);

impl EventSink for Recorder {
    fn emit(&self, event: &AcpEvent) {
        self.0
            .lock()
            .push((event.sid.clone(), event.type_, event.payload.clone()));
    }
}

impl Recorder {
    fn types(&self) -> Vec<&'static str> {
        self.0.lock().iter().map(|(_, t, _)| *t).collect()
    }

    fn last(&self) -> Value {
        self.0
            .lock()
            .last()
            .map(|(_, _, p)| p.clone())
            .expect("an event")
    }
}

fn tickets(floor: Duration) -> (Arc<Recorder>, Arc<HostTickets>) {
    let recorder = Arc::new(Recorder::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![recorder.clone()];
    let tickets = HostTickets::new(sinks, Box::new(|session| session != "nobody-watching"))
        .with_answer_floor(floor);
    (recorder, Arc::new(tickets))
}

fn ticket(session: &str, url: &str) -> TicketRequest {
    TicketRequest {
        id: TicketId::mint(),
        session_id: session.into(),
        project_id: "p1".into(),
        origin: CanonicalOrigin::parse(url).unwrap(),
        target_url: url.into(),
        action: ActionClass::Navigate,
        element: Some("Docs link".into()),
        file: None,
        profile: TabProfile::Global,
        options: &ConsentOption::ALL,
    }
}

const REMOTE_OK: Approver = Approver::Remote {
    token_authenticated: true,
    subscribed: true,
};

async fn raised(tickets: &HostTickets, recorder: &Recorder) -> String {
    for _ in 0..100 {
        let pending = recorder
            .0
            .lock()
            .iter()
            .rev()
            .filter(|(_, t, _)| *t == "acp:permission_request")
            .filter_map(|(_, _, p)| p["requestId"].as_str().map(str::to_string))
            .find(|id| tickets.is_pending(id));
        if let Some(id) = pending {
            return id;
        }
        tokio::task::yield_now().await;
    }
    panic!("no ticket was raised");
}

#[tokio::test]
async fn a_ticket_goes_out_on_the_acp_permission_contract() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    let request = ticket("s1", "https://docs.example.com/guide?q=1");
    let id = request.id.as_str().to_string();
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move { tickets.request(request, Duration::from_secs(5)).await }
    });
    raised(&tickets, &recorder).await;
    let (sid, ty, payload) = recorder.0.lock()[0].clone();
    assert_eq!((sid.as_deref(), ty), (Some("s1"), "acp:permission_request"));
    assert_eq!(payload["requestId"], id.as_str());
    assert!(payload["toolCall"]["toolCallId"].is_null());
    assert_eq!(payload["_meta"]["termul"]["origin_kind"], "browser");
    assert_eq!(
        payload["_meta"]["termul"]["browser"]["origin"],
        "https://docs.example.com"
    );
    assert_eq!(
        payload["_meta"]["termul"]["browser"]["element"],
        "Docs link"
    );
    assert_eq!(payload["_meta"]["termul"]["browser"]["profile"], "global");
    let options: Vec<(String, String, Value)> = payload["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["optionId"].as_str().unwrap().into(),
                o["kind"].as_str().unwrap().into(),
                o["_meta"]["termul"]["scope"].clone(),
            )
        })
        .collect();
    assert_eq!(
        options,
        vec![
            (
                "allow_session".into(),
                "allow_once".into(),
                json!("session")
            ),
            (
                "allow_project".into(),
                "allow_always".into(),
                json!("project")
            ),
            ("deny".into(), "reject_once".into(), Value::Null),
        ]
    );

    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_project")),
        Ok(ConsentOption::AllowProject)
    );
    assert_eq!(
        waiting.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::AllowProject)
    );
    assert_eq!(
        recorder.types(),
        ["acp:permission_request", "acp:browser_ticket_closed"]
    );
    assert_eq!(
        recorder.last(),
        json!({ "sessionId": "s1", "requestId": id, "outcome": "allow_project" })
    );
}

#[tokio::test]
async fn the_first_answer_wins_from_either_surface() {
    for (first, second) in [
        (Approver::Desktop, REMOTE_OK),
        (REMOTE_OK, Approver::Desktop),
    ] {
        let (recorder, tickets) = tickets(Duration::ZERO);
        let waiting = tokio::spawn({
            let tickets = tickets.clone();
            async move {
                tickets
                    .request(ticket("s1", "https://a.example"), Duration::from_secs(5))
                    .await
            }
        });
        let id = raised(&tickets, &recorder).await;
        assert_eq!(
            tickets.answer(first, &id, Some("allow_session")),
            Ok(ConsentOption::AllowSession)
        );
        assert_eq!(
            tickets.answer(second, &id, Some("deny")),
            Err(AnswerError::AlreadyResolved)
        );
        assert_eq!(
            waiting.await.unwrap(),
            TicketOutcome::Answered(ConsentOption::AllowSession)
        );
    }
}

#[tokio::test]
async fn unbound_or_token_less_clients_cannot_answer() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s1", "https://a.example"), Duration::from_secs(5))
                .await
        }
    });
    let id = raised(&tickets, &recorder).await;
    for approver in [
        Approver::Remote {
            token_authenticated: false,
            subscribed: true,
        },
        Approver::Remote {
            token_authenticated: true,
            subscribed: false,
        },
        Approver::Remote {
            token_authenticated: false,
            subscribed: false,
        },
    ] {
        assert_eq!(
            tickets.answer(approver, &id, Some("allow_session")),
            Err(AnswerError::Unqualified),
            "{approver:?}"
        );
    }
    assert!(
        tickets.is_pending(&id),
        "a refused answer leaves the ticket open"
    );
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, None),
        Ok(ConsentOption::Deny)
    );
    assert_eq!(
        waiting.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::Deny)
    );
}

#[tokio::test]
async fn an_answer_faster_than_the_floor_is_refused() {
    let (recorder, tickets) = tickets(Duration::from_millis(300));
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s1", "https://a.example"), Duration::from_secs(5))
                .await
        }
    });
    let id = raised(&tickets, &recorder).await;
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_session")),
        Err(AnswerError::TooEarly)
    );
    assert!(tickets.is_pending(&id));
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_session")),
        Ok(ConsentOption::AllowSession)
    );
    assert_eq!(
        waiting.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::AllowSession)
    );
    assert_eq!(
        ANSWER_FLOOR,
        Duration::from_millis(750),
        "the production floor"
    );
}

#[tokio::test]
async fn an_upload_ticket_names_the_file_by_base_name_and_size() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    let request = TicketRequest {
        action: ActionClass::Upload,
        file: Some(TicketFile {
            name: "report.pdf".into(),
            bytes: 9,
        }),
        ..ticket("s1", "https://files.example/upload")
    };
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move { tickets.request(request, Duration::from_secs(5)).await }
    });
    raised(&tickets, &recorder).await;
    let payload = recorder.0.lock()[0].2.clone();
    assert_eq!(payload["toolCall"]["title"], "Upload report.pdf (9 bytes) to https://files.example");
    assert_eq!(
        payload["_meta"]["termul"]["browser"]["file"],
        json!({ "name": "report.pdf", "bytes": 9 })
    );
    waiting.abort();
}

#[tokio::test]
async fn a_sensitive_ticket_offers_only_its_options_and_names_them_for_one_action() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    let request = TicketRequest {
        action: ActionClass::PasswordSubmit,
        options: &ConsentOption::ONCE_OR_DENY,
        ..ticket("s1", "https://bank.example/login")
    };
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move { tickets.request(request, Duration::from_secs(5)).await }
    });
    let id = raised(&tickets, &recorder).await;
    let payload = recorder.0.lock()[0].2.clone();
    assert_eq!(payload["toolCall"]["title"], "Submit a password on https://bank.example");
    assert_eq!(payload["_meta"]["termul"]["browser"]["action"], "password_submit");
    assert_eq!(
        payload["options"],
        json!([
            { "optionId": "allow_session", "name": "Allow once", "kind": "allow_once",
              "_meta": { "termul": { "scope": "once" } } },
            { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
        ])
    );
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_project")),
        Err(AnswerError::InvalidOption),
        "an option the ticket never offered cannot answer it"
    );
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_session")),
        Ok(ConsentOption::AllowSession)
    );
    assert_eq!(
        waiting.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::AllowSession)
    );
}

#[tokio::test]
async fn unknown_options_and_ids_are_rejected() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    let _waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s1", "https://a.example"), Duration::from_secs(5))
                .await
        }
    });
    let id = raised(&tickets, &recorder).await;
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_always")),
        Err(AnswerError::InvalidOption)
    );
    assert_eq!(
        tickets.answer(Approver::Desktop, TicketId::mint().as_str(), Some("deny")),
        Err(AnswerError::NotFound)
    );
}

/// The relay's subscriptions are the attended signal: a session no client
/// subscribes to resolves at once and shows nothing, a subscribed client
/// receives the prompt, and the session is unattended again once it leaves.
#[tokio::test]
async fn a_session_without_a_subscribed_client_resolves_at_once_without_a_prompt() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("s1");
    let tickets = Arc::new(HostTickets::for_relay(Arc::clone(&relay)).with_answer_floor(Duration::ZERO));
    let started = Instant::now();
    assert_eq!(
        tickets
            .request(ticket("s1", "https://a.example"), Duration::from_secs(120))
            .await,
        TicketOutcome::Unattended
    );
    assert!(started.elapsed() < Duration::from_secs(1));

    let closing = tokio_util::sync::CancellationToken::new();
    let (client, mut stream, _, _) = relay.subscribe("s1", None, None, &closing).await;
    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s1", "https://a.example"), Duration::from_secs(5))
                .await
        }
    });
    let shown = tokio::time::timeout(Duration::from_secs(5), stream.recv())
        .await
        .expect("the subscriber is shown the prompt")
        .expect("stream open");
    let shown = format!("{shown:?}");
    assert!(shown.contains("permission_request"), "{shown}");
    let id = loop {
        if let Some(id) = tickets.state.lock().pending.keys().next().cloned() {
            break id;
        }
        tokio::task::yield_now().await;
    };
    tickets.answer(Approver::Desktop, &id, None).unwrap();
    assert_eq!(
        waiting.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::Deny)
    );

    relay.unsubscribe("s1", client);
    assert_eq!(
        tickets
            .request(ticket("s1", "https://a.example"), Duration::from_secs(120))
            .await,
        TicketOutcome::Unattended
    );
}

#[tokio::test]
async fn timeout_cancel_and_abandon_all_close_the_ticket_everywhere() {
    let (recorder, tickets) = tickets(Duration::ZERO);
    assert_eq!(
        tickets
            .request(ticket("s1", "https://a.example"), Duration::from_millis(20))
            .await,
        TicketOutcome::TimedOut
    );
    assert_eq!(recorder.last()["outcome"], "timed_out");

    let waiting = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s1", "https://b.example"), Duration::from_secs(5))
                .await
        }
    });
    let id = raised(&tickets, &recorder).await;
    tickets.cancel_session("other");
    assert!(tickets.is_pending(&id), "cancel is session-scoped");
    tickets.cancel_session("s1");
    assert_eq!(waiting.await.unwrap(), TicketOutcome::Cancelled);
    assert_eq!(recorder.last()["outcome"], "cancelled");
    assert_eq!(
        tickets.answer(Approver::Desktop, &id, Some("allow_session")),
        Err(AnswerError::AlreadyResolved)
    );

    let abandoned = tokio::spawn({
        let tickets = tickets.clone();
        async move {
            tickets
                .request(ticket("s2", "https://c.example"), Duration::from_secs(5))
                .await
        }
    });
    let id = loop {
        let id = raised(&tickets, &recorder).await;
        if tickets.session_of(&id).as_deref() == Some("s2") {
            break id;
        }
    };
    abandoned.abort();
    let _ = abandoned.await;
    assert!(
        !tickets.is_pending(&id),
        "dropping the waiter withdraws the ticket"
    );
    assert_eq!(recorder.last()["requestId"], id.as_str());
}

#[test]
fn the_displayed_url_cuts_long_queries_and_keeps_the_byte_count() {
    let long = format!("https://a.example/path?token={}", "x".repeat(400));
    let shown = display_url(&long);
    assert!(shown.starts_with("https://a.example/path?token=x"));
    assert!(shown.ends_with('…'));
    assert!(shown.len() < 130);
    assert_eq!(
        display_url("https://a.example/p?q=1#f"),
        "https://a.example/p?q=1#f"
    );
    let payload = request_payload(&ticket("s1", &long));
    assert_eq!(
        payload["_meta"]["termul"]["browser"]["targetUrlBytes"],
        long.len()
    );
    assert!(is_host_ticket_id(TicketId::mint().as_str()));
    assert!(!is_host_ticket_id("perm-123"));
}
