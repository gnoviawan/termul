#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Host-originated browser consent tickets over `/ws` `respond_permission`
//! and the `browser_stop` route: approver rules and first-answer-wins.

use std::time::Duration;

use super::tests::{route, test_env, test_outbound};
use super::*;
use crate::acp::host_ticket::{AnswerError, Approver, HostTickets};
use crate::browser_automation::core::ports::{
    ActionClass, CanonicalOrigin, ConsentOption, PermissionRequest, TabProfile, TicketId,
    TicketOutcome, TicketRequest,
};
use crate::web::auth::{WebAuth, WebAuthToken};
use crate::web::permissions::PermissionRendezvous;

const SESSION: &str = "sess-browser";

struct Rig {
    relay: Arc<WsRelaySink>,
    rendezvous: Arc<PermissionRendezvous>,
    tickets: Arc<HostTickets>,
    acp: Arc<AcpManager>,
    registry: Arc<ProjectRegistry>,
}

fn rig(floor: Duration) -> Rig {
    let relay = Arc::new(WsRelaySink::new());
    let rendezvous = Arc::new(PermissionRendezvous::default());
    let sinks: Vec<Arc<dyn crate::web::EventSink>> = vec![relay.clone()];
    let tickets = Arc::new(HostTickets::new(sinks, Box::new(|_| true)).with_answer_floor(floor));
    rendezvous.set_host_tickets(tickets.clone());
    relay.set_rendezvous(rendezvous.clone());
    relay.seed_session_for_test(SESSION);
    Rig {
        relay,
        rendezvous,
        tickets,
        acp: Arc::new(AcpManager::new(vec![])),
        registry: Arc::new(ProjectRegistry::new()),
    }
}

fn gate() -> Arc<WebAuth> {
    Arc::new(WebAuth::new(
        WebAuthToken::new("s3cret-token").expect("non-empty"),
    ))
}

/// A connection: `token` = passed the web-token gate, `subscribed` = holds a
/// subscription to [`SESSION`].
fn env(rig: &Rig, carrier: Carrier, token: bool, subscribed: bool) -> HandlerEnv {
    let (tx, _rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    if subscribed {
        subscriptions.replace(SESSION, &[], ClientId::new());
    }
    HandlerEnv {
        carrier,
        web_auth: token.then(gate),
        ..test_env(&rig.acp, &rig.relay, &rig.registry, &tx, &subscriptions)
    }
}

fn raise(rig: &Rig) -> (String, tokio::task::JoinHandle<TicketOutcome>) {
    let id = TicketId::mint();
    let ticket = TicketRequest {
        id: id.clone(),
        session_id: SESSION.into(),
        project_id: "p1".into(),
        origin: CanonicalOrigin::parse("https://docs.example.com").unwrap(),
        target_url: "https://docs.example.com/start".into(),
        action: ActionClass::Navigate,
        element: None,
        file: None,
        profile: TabProfile::Global,
        options: &ConsentOption::ALL,
    };
    let tickets = rig.tickets.clone();
    let waiter =
        tokio::spawn(async move { tickets.request(ticket, Duration::from_secs(10)).await });
    (id.as_str().to_string(), waiter)
}

async fn until_pending(rig: &Rig, id: &str) {
    for _ in 0..100 {
        if rig.tickets.is_pending(id) {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("ticket never raised");
}

fn answer_frame(id: &str, option: &str) -> String {
    json!({"id": "r1", "type": "respond_permission", "payload": {"requestId": id, "optionId": option}}).to_string()
}

fn err_code(reply: &WsReply) -> String {
    reply
        .err
        .as_ref()
        .map(|e| e.code.to_string())
        .unwrap_or_default()
}

#[tokio::test]
async fn an_authenticated_client_of_the_session_resolves_the_ticket() {
    let rig = rig(Duration::ZERO);
    let (id, waiter) = raise(&rig);
    until_pending(&rig, &id).await;
    assert!(
        rig.rendezvous.session_for_request(&id).is_none(),
        "a host ticket never enters the agent permission table"
    );
    let reply = route(
        &answer_frame(&id, "allow_session"),
        &env(&rig, Carrier::Ws, true, true),
    )
    .await;
    assert!(reply.ok, "the route refused the frame");
    assert_eq!(
        waiter.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::AllowSession)
    );
}

#[tokio::test]
async fn unbound_token_less_and_channel_clients_are_rejected() {
    let rig = rig(Duration::ZERO);
    let (id, waiter) = raise(&rig);
    until_pending(&rig, &id).await;
    for (carrier, token, subscribed) in [
        (Carrier::Ws, false, true),
        (Carrier::Ws, true, false),
        (Carrier::Ws, false, false),
        (Carrier::Ipc, false, true),
    ] {
        let reply = route(
            &answer_frame(&id, "allow_session"),
            &env(&rig, carrier, token, subscribed),
        )
        .await;
        assert_eq!(
            err_code(&reply),
            "permission_denied",
            "{carrier:?} token={token} subscribed={subscribed}"
        );
    }
    assert!(
        rig.tickets.is_pending(&id),
        "refused answers leave the ticket open"
    );
    rig.tickets.answer(Approver::Desktop, &id, None).unwrap();
    assert_eq!(
        waiter.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::Deny)
    );
}

#[tokio::test]
async fn a_sub_floor_answer_is_rejected() {
    let rig = rig(crate::acp::host_ticket::ANSWER_FLOOR);
    let (id, waiter) = raise(&rig);
    until_pending(&rig, &id).await;
    let reply = route(
        &answer_frame(&id, "allow_session"),
        &env(&rig, Carrier::Ws, true, true),
    )
    .await;
    assert_eq!(err_code(&reply), "rate_limited");
    assert_eq!(
        rig.tickets
            .answer(Approver::Desktop, &id, Some("allow_session")),
        Err(AnswerError::TooEarly),
        "the desktop command has the same floor"
    );
    assert!(rig.tickets.is_pending(&id));
    waiter.abort();
}

#[tokio::test]
async fn the_first_answer_wins_across_the_command_and_the_route() {
    let rig = rig(Duration::ZERO);
    let (id, waiter) = raise(&rig);
    until_pending(&rig, &id).await;
    assert_eq!(
        rig.tickets.answer(Approver::Desktop, &id, Some("deny")),
        Ok(ConsentOption::Deny)
    );
    let reply = route(
        &answer_frame(&id, "allow_project"),
        &env(&rig, Carrier::Ws, true, true),
    )
    .await;
    assert_eq!(err_code(&reply), "already_resolved");
    assert_eq!(
        waiter.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::Deny)
    );

    let (id, waiter) = raise(&rig);
    until_pending(&rig, &id).await;
    let reply = route(
        &answer_frame(&id, "allow_project"),
        &env(&rig, Carrier::Ws, true, true),
    )
    .await;
    assert!(reply.ok);
    assert_eq!(
        rig.tickets.answer(Approver::Desktop, &id, Some("deny")),
        Err(AnswerError::AlreadyResolved)
    );
    assert_eq!(
        waiter.await.unwrap(),
        TicketOutcome::Answered(ConsentOption::AllowProject)
    );
}

#[tokio::test]
async fn a_host_id_without_a_resolver_is_stale_and_never_reaches_an_agent() {
    let relay = Arc::new(WsRelaySink::new());
    relay.set_rendezvous(Arc::new(PermissionRendezvous::default()));
    let rig = Rig {
        relay,
        rendezvous: Arc::new(PermissionRendezvous::default()),
        tickets: Arc::new(HostTickets::new(vec![], Box::new(|_| true))),
        acp: Arc::new(AcpManager::new(vec![])),
        registry: Arc::new(ProjectRegistry::new()),
    };
    let reply = route(
        &answer_frame(TicketId::mint().as_str(), "allow_session"),
        &env(&rig, Carrier::Ws, true, true),
    )
    .await;
    assert_eq!(err_code(&reply), "stale");
}

struct StopHost(parking_lot::Mutex<Vec<String>>);

impl crate::browser_automation::BrowserHost for StopHost {
    fn execute<'a>(
        &'a self,
        _session_id: &'a str,
        _agent_id: &'a str,
        _call: crate::browser_automation::BrowserCall,
        _deadline: crate::browser_automation::budgets::Deadline,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        crate::browser_automation::Success,
                        crate::browser_automation::BrowserError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async { Ok(crate::browser_automation::Success::default()) })
    }
    fn end_session(&self, _session_id: &str) {}
    fn engine_facts(&self) -> crate::browser_automation::engine::EngineFacts {
        crate::browser_automation::engine::EngineFacts::all_trusted()
    }
    fn stop(&self, session_id: &str) -> bool {
        self.0.lock().push(session_id.to_string());
        true
    }
}

#[test]
fn browser_stop_needs_an_authenticated_client_of_the_session() {
    let _host = crate::browser_automation::TEST_HOST_LOCK.lock().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let rig = rig(Duration::ZERO);
    let frame =
        json!({"id": "s1", "type": "browser_stop", "payload": {"sessionId": SESSION}}).to_string();

    crate::browser_automation::clear_browser_host();
    let reply = runtime.block_on(route(&frame, &env(&rig, Carrier::Ws, true, true)));
    assert_eq!(
        err_code(&reply),
        "unsupported",
        "no automation host in this process"
    );

    let host = Arc::new(StopHost(parking_lot::Mutex::new(Vec::new())));
    crate::browser_automation::set_browser_host(host.clone());
    for (carrier, token, subscribed) in [
        (Carrier::Ws, false, true),
        (Carrier::Ws, true, false),
        (Carrier::Ipc, false, true),
    ] {
        let reply = runtime.block_on(route(&frame, &env(&rig, carrier, token, subscribed)));
        assert_eq!(
            err_code(&reply),
            "permission_denied",
            "{carrier:?} token={token} subscribed={subscribed}"
        );
    }
    assert!(
        host.0.lock().is_empty(),
        "refused stops never reach the host"
    );
    let reply = runtime.block_on(route(&frame, &env(&rig, Carrier::Ws, true, true)));
    assert!(reply.ok, "the route refused the frame");
    assert_eq!(host.0.lock().as_slice(), [SESSION.to_string()]);
    let reply = runtime.block_on(route(
        &json!({"id": "s2", "type": "browser_stop", "payload": {}}).to_string(),
        &env(&rig, Carrier::Ws, true, true),
    ));
    assert_eq!(err_code(&reply), "unsupported");
    crate::browser_automation::clear_browser_host();
}
