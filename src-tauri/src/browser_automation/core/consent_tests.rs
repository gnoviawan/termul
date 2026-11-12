use std::time::{Duration, Instant};

use tokio::sync::{oneshot, Notify};

use super::*;
use crate::browser_automation::core::ports::{ActionClass, AppPolicy, AppPolicyOp, PortFuture, ProjectPolicy};
use crate::browser_automation::core::test_support::{InMemoryPolicyStore, ScriptedPermissions};

/// Tickets wait until the test answers them.
#[derive(Default)]
struct ManualPermissions {
    waiting: Mutex<Vec<(TicketRequest, oneshot::Sender<TicketOutcome>)>>,
    raised: Notify,
}

impl ManualPermissions {
    async fn next_ticket(&self) -> TicketRequest {
        loop {
            let notified = self.raised.notified();
            if let Some((ticket, _)) = self.waiting.lock().first() {
                return ticket.clone();
            }
            notified.await;
        }
    }

    /// Answer the oldest ticket, if Stop has not withdrawn it already.
    fn answer(&self, outcome: TicketOutcome) {
        let mut waiting = self.waiting.lock();
        if !waiting.is_empty() {
            let (_, tx) = waiting.remove(0);
            let _ = tx.send(outcome);
        }
    }
}

impl PermissionRequest for ManualPermissions {
    fn request(&self, ticket: TicketRequest, _wait: Duration) -> PortFuture<'_, TicketOutcome> {
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().push((ticket, tx));
        self.raised.notify_waiters();
        Box::pin(async move { rx.await.unwrap_or(TicketOutcome::Cancelled) })
    }

    fn cancel_session(&self, session_id: &str) {
        let mut waiting = self.waiting.lock();
        let (cancelled, kept) = std::mem::take(&mut *waiting)
            .into_iter()
            .partition::<Vec<_>, _>(|(t, _)| t.session_id == session_id);
        *waiting = kept;
        for (_, tx) in cancelled {
            let _ = tx.send(TicketOutcome::Cancelled);
        }
    }
}

fn req<'a>(session_id: &'a str, url: &'a str) -> OriginRequest<'a> {
    OriginRequest {
        session_id,
        project_id: "p1",
        url,
        element: Some("Sign in"),
        profile: TabProfile::Global,
        deadline: Deadline::after(budgets::FRAME_BUDGET),
    }
}

async fn authorize(gate: &ConsentGate, session_id: &str, url: &str) -> Result<(), BrowserError> {
    let token = gate.begin(session_id)?;
    token
        .guard(gate.authorize(&token, req(session_id, url)))
        .await
}

fn scripted(
    outcomes: impl IntoIterator<Item = TicketOutcome>,
) -> (
    Arc<ScriptedPermissions>,
    Arc<InMemoryPolicyStore>,
    ConsentGate,
) {
    let perms = Arc::new(ScriptedPermissions::answering(outcomes));
    let store = Arc::new(InMemoryPolicyStore::default());
    let gate = ConsentGate::new(perms.clone(), store.clone());
    (perms, store, gate)
}

fn code_reason(err: &BrowserError) -> (&'static str, Option<&'static str>) {
    (err.code, err.reason)
}

#[tokio::test]
async fn loopback_dev_ports_and_allow_listed_origins_never_prompt() {
    let (perms, store, gate) = scripted([]);
    store
        .apply_project(
            "p1",
            0,
            ProjectPolicyOp::AddOrigin(OriginPattern::parse("https://*.example.com").unwrap()),
        )
        .await
        .unwrap();
    for url in [
        "http://localhost:3000/",
        "http://127.0.0.1:8080/x",
        "http://[::1]:5173",
        "https://docs.example.com/guide?a=1",
        "https://api.example.com",
    ] {
        authorize(&gate, "s1", url)
            .await
            .unwrap_or_else(|e| panic!("{url}: {e}"));
    }
    assert!(perms.requests.lock().is_empty(), "zero prompts");
}

#[tokio::test]
async fn an_unlisted_origin_prompts_once_per_session() {
    let (perms, _store, gate) = scripted([
        TicketOutcome::Answered(ConsentOption::AllowSession),
        TicketOutcome::Answered(ConsentOption::AllowSession),
    ]);
    authorize(&gate, "s1", "https://news.example.org/a")
        .await
        .unwrap();
    authorize(&gate, "s1", "https://news.example.org/b?page=2")
        .await
        .unwrap();
    assert_eq!(
        perms.requests.lock().len(),
        1,
        "the second call reuses the session grant"
    );

    let (ticket, wait) = perms.requests.lock()[0].clone();
    assert_eq!(ticket.origin.as_str(), "https://news.example.org");
    assert_eq!(ticket.target_url, "https://news.example.org/a");
    assert_eq!(ticket.action, ActionClass::Navigate);
    assert_eq!(ticket.element.as_deref(), Some("Sign in"));
    assert_eq!(
        (ticket.session_id.as_str(), ticket.project_id.as_str()),
        ("s1", "p1")
    );
    assert!(ticket.id.as_str().starts_with("host:"));
    assert_eq!(wait, budgets::CONSENT_WAIT);

    authorize(&gate, "s2", "https://news.example.org/a")
        .await
        .unwrap();
    assert_eq!(
        perms.requests.lock().len(),
        2,
        "grants never cross sessions"
    );
}

#[tokio::test]
async fn concurrent_calls_share_one_prompt() {
    let perms = Arc::new(ManualPermissions::default());
    let gate = Arc::new(ConsentGate::new(perms.clone(), Arc::new(InMemoryPolicyStore::default())));
    let calls: Vec<_> = (0..3)
        .map(|_| {
            let gate = gate.clone();
            tokio::spawn(async move { authorize(&gate, "s1", "https://shop.example").await })
        })
        .collect();
    perms.next_ticket().await;
    tokio::task::yield_now().await;
    assert_eq!(perms.waiting.lock().len(), 1, "only one ticket is raised");
    perms.answer(TicketOutcome::Answered(ConsentOption::AllowSession));
    for call in calls {
        call.await.unwrap().unwrap();
    }
    assert!(perms.waiting.lock().is_empty());
}

#[tokio::test]
async fn always_allow_for_this_project_persists_through_the_policy_store() {
    let (perms, store, gate) = scripted([TicketOutcome::Answered(ConsentOption::AllowProject)]);
    authorize(&gate, "s1", "https://dashboard.example.net/home")
        .await
        .unwrap();
    let policy = store.project("p1").await.unwrap();
    assert_eq!(
        policy.allow_list,
        vec![OriginPattern::Exact(
            CanonicalOrigin::parse("https://dashboard.example.net").unwrap()
        )]
    );
    assert_eq!(policy.revision, 1);

    authorize(&gate, "s9", "https://dashboard.example.net/other")
        .await
        .unwrap();
    assert_eq!(
        perms.requests.lock().len(),
        1,
        "a later session of the project is not prompted"
    );
}

#[tokio::test]
async fn always_allow_lands_in_the_project_policy_file_and_survives_a_restart() {
    use crate::acp::browser_policy::test_support::fixture;
    let root = tempfile::tempdir().unwrap();
    let perms = Arc::new(ScriptedPermissions::answering([TicketOutcome::Answered(
        ConsentOption::AllowProject,
    )]));
    let first = fixture(root.path(), Vec::new());
    first
        .service
        .apply_app_op(0, crate::acp::browser_policy::AppPolicyOp::SetAskBeforeOpeningSites(true))
        .await
        .unwrap();
    let gate = ConsentGate::new(perms.clone(), first.service.clone());
    authorize(&gate, "session-a", "https://dashboard.example.net/home")
        .await
        .unwrap();
    authorize(&gate, "session-b", "https://dashboard.example.net/other")
        .await
        .unwrap();
    assert_eq!(perms.requests.lock().len(), 1, "session B of the project is not prompted");

    let restarted = fixture(root.path(), Vec::new());
    let gate = ConsentGate::new(perms.clone(), restarted.service.clone());
    authorize(&gate, "session-c", "https://dashboard.example.net/")
        .await
        .unwrap();
    assert_eq!(perms.requests.lock().len(), 1, "the grant outlives the app");
    let view = restarted.service.project_policy("p1").await.unwrap();
    assert_eq!(
        view.allow_list,
        vec![OriginPattern::parse("https://dashboard.example.net").unwrap()]
    );
}

#[tokio::test]
async fn always_allow_retries_a_concurrent_policy_edit() {
    let store = Arc::new(InMemoryPolicyStore::default());
    let perms_for_race = Arc::new(ManualPermissions::default());
    let racing_gate = Arc::new(ConsentGate::new(perms_for_race.clone(), store.clone()));
    let racing = tokio::spawn({
        let gate = racing_gate.clone();
        async move { authorize(&gate, "s1", "https://a.example").await }
    });
    perms_for_race.next_ticket().await;
    store
        .apply_project(
            "p1",
            0,
            ProjectPolicyOp::AddOrigin(OriginPattern::parse("https://b.example").unwrap()),
        )
        .await
        .unwrap();
    perms_for_race.answer(TicketOutcome::Answered(ConsentOption::AllowProject));
    racing.await.unwrap().unwrap();
    let policy = store.project("p1").await.unwrap();
    assert_eq!(
        policy.allow_list.len(),
        2,
        "neither edit is lost: {:?}",
        policy.allow_list
    );
}

#[tokio::test]
async fn never_reachable_origins_are_denied_without_a_prompt() {
    let _listener = crate::host_perimeter::OwnedPort::claim(47_123);
    let (perms, store, gate) = scripted([]);
    store
        .apply_project(
            "p1",
            0,
            ProjectPolicyOp::AddOrigin(OriginPattern::parse("http://169.254.169.254").unwrap()),
        )
        .await
        .unwrap();
    for (url, reason) in [
        ("http://127.0.0.1:47123/mcp", "troupe_owned_origin"),
        ("http://tauri.localhost/", "app_origin"),
        ("http://0.0.0.0:3000", "unspecified_address"),
        ("http://169.254.169.254/latest", "metadata_address"),
        ("http://metadata.google.internal/", "metadata_address"),
    ] {
        let err = authorize(&gate, "s1", url).await.unwrap_err();
        assert_eq!(code_reason(&err), ("invalid_params", Some(reason)), "{url}");
    }
    assert!(
        perms.requests.lock().is_empty(),
        "denied origins are never promptable"
    );
}

#[tokio::test]
async fn an_unattended_run_gets_confirmation_required_within_a_second() {
    let (_perms, _store, gate) = scripted([TicketOutcome::Unattended]);
    let started = Instant::now();
    let err = authorize(&gate, "s1", "https://unapproved.example")
        .await
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("unattended"))
    );
}

#[tokio::test]
async fn a_denial_grants_nothing_and_the_next_call_asks_again() {
    let (perms, _store, gate) = scripted([
        TicketOutcome::Answered(ConsentOption::Deny),
        TicketOutcome::TimedOut,
    ]);
    let err = authorize(&gate, "s1", "https://x.example")
        .await
        .unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("denied_by_user"))
    );
    let err = authorize(&gate, "s1", "https://x.example")
        .await
        .unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("consent_timeout"))
    );
    assert_eq!(perms.requests.lock().len(), 2);
}

#[tokio::test]
async fn stop_denies_the_pending_prompt_revokes_grants_and_latches_until_the_next_turn() {
    let perms = Arc::new(ManualPermissions::default());
    let gate = Arc::new(ConsentGate::new(perms.clone(), Arc::new(InMemoryPolicyStore::default())));

    let granted = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://granted.example").await }
    });
    perms.next_ticket().await;
    perms.answer(TicketOutcome::Answered(ConsentOption::AllowSession));
    granted.await.unwrap().unwrap();

    let pending = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://pending.example").await }
    });
    perms.next_ticket().await;
    assert!(gate.stop("s1"));
    let err = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("stopped_by_user"))
    );
    assert!(
        perms.waiting.lock().is_empty(),
        "the pending ticket was withdrawn"
    );

    for url in ["http://localhost:3000", "https://granted.example"] {
        let err = authorize(&gate, "s1", url).await.unwrap_err();
        assert_eq!(
            code_reason(&err),
            ("confirmation_required", Some("stopped_by_user")),
            "{url}"
        );
    }

    assert!(gate.resume("s1"));
    authorize(&gate, "s1", "http://localhost:3000")
        .await
        .unwrap();
    let after = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://granted.example").await }
    });
    perms.next_ticket().await;
    assert_eq!(
        perms.waiting.lock().len(),
        1,
        "the session grant was revoked by Stop"
    );
    perms.answer(TicketOutcome::Answered(ConsentOption::Deny));
    assert!(after.await.unwrap().is_err());
}

#[tokio::test]
async fn revoking_access_drops_grants_and_pending_tickets_but_keeps_an_active_stop() {
    let perms = Arc::new(ManualPermissions::default());
    let gate = Arc::new(ConsentGate::new(perms.clone(), Arc::new(InMemoryPolicyStore::default())));

    let granted = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://granted.example").await }
    });
    perms.next_ticket().await;
    perms.answer(TicketOutcome::Answered(ConsentOption::AllowSession));
    granted.await.unwrap().unwrap();
    authorize(&gate, "s1", "https://granted.example").await.unwrap();

    let pending = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://pending.example").await }
    });
    perms.next_ticket().await;
    gate.revoke_access("s1");
    let err = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("consent_cancelled"))
    );
    assert!(!gate.is_stopped("s1"), "revoking is not a Stop");

    let again = tokio::spawn({
        let gate = gate.clone();
        async move { authorize(&gate, "s1", "https://granted.example").await }
    });
    perms.next_ticket().await;
    assert_eq!(perms.waiting.lock().len(), 1, "the grant was revoked");
    perms.answer(TicketOutcome::Answered(ConsentOption::Deny));
    assert!(again.await.unwrap().is_err());

    assert!(gate.stop("s1"));
    gate.revoke_access("s1");
    assert!(gate.is_stopped("s1"), "an active Stop survives the revoke");
    let err = authorize(&gate, "s1", "http://localhost:3000").await.unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("stopped_by_user"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_wins_every_race_against_allow() {
    for round in 0..100 {
        let perms = Arc::new(ManualPermissions::default());
        let gate = Arc::new(ConsentGate::new(perms.clone(), Arc::new(InMemoryPolicyStore::default())));
        let call = tokio::spawn({
            let gate = gate.clone();
            async move { authorize(&gate, "s1", "https://race.example").await }
        });
        perms.next_ticket().await;
        let (allow, stop) = {
            let (p, g) = (perms.clone(), gate.clone());
            let allow = tokio::spawn(async move {
                p.answer(TicketOutcome::Answered(ConsentOption::AllowSession))
            });
            let stop = tokio::spawn(async move { g.stop("s1") });
            (allow, stop)
        };
        if round % 2 == 0 {
            allow.await.unwrap();
            stop.await.unwrap();
        } else {
            stop.await.unwrap();
            allow.await.unwrap();
        }
        // The call may finish just before Stop lands; what Stop guarantees
        // is that nothing granted before it survives.
        let _ = call.await.unwrap();
        assert!(gate.is_stopped("s1"), "round {round}");
        assert!(gate.resume("s1"));
        let after = tokio::spawn({
            let gate = gate.clone();
            async move { authorize(&gate, "s1", "https://race.example").await }
        });
        perms.next_ticket().await;
        perms.answer(TicketOutcome::Answered(ConsentOption::Deny));
        assert!(
            after.await.unwrap().is_err(),
            "round {round}: the grant did not survive Stop"
        );
    }
}

#[tokio::test]
async fn a_stop_that_lands_while_allow_is_in_flight_refuses_the_call() {
    let perms = Arc::new(ManualPermissions::default());
    let gate = Arc::new(ConsentGate::new(perms.clone(), Arc::new(InMemoryPolicyStore::default())));
    let token = gate.begin("s1").unwrap();
    let call = {
        let gate = gate.clone();
        tokio::spawn(async move {
            gate.authorize(&token, req("s1", "https://race.example"))
                .await
        })
    };
    perms.next_ticket().await;
    gate.stop.stop("s1", || gate.grants.revoke_session("s1"));
    perms.answer(TicketOutcome::Answered(ConsentOption::AllowSession));
    let err = call.await.unwrap().unwrap_err();
    assert_eq!(
        code_reason(&err),
        ("confirmation_required", Some("stopped_by_user"))
    );
    let race: Url = "https://race.example/".parse().unwrap();
    assert!(
        matches!(
            gate.grants.check_hop("s1", &race),
            HopVerdict::Ungranted(..)
        ),
        "an Allow answered after Stop records no grant"
    );
}

#[tokio::test]
async fn session_end_withdraws_tickets_and_forgets_grants() {
    let (perms, _store, gate) = scripted([TicketOutcome::Answered(ConsentOption::AllowSession)]);
    authorize(&gate, "s1", "https://kept.example")
        .await
        .unwrap();
    gate.end_session("s1");
    assert_eq!(
        perms.cancelled_sessions.lock().as_slice(),
        ["s1".to_string()]
    );
    authorize(&gate, "s1", "https://kept.example")
        .await
        .unwrap_err();
    assert_eq!(
        perms.requests.lock().len(),
        2,
        "the ended session's grant is gone"
    );
}

/// A policy store whose app policy cannot be read.
struct UnreadableAppPolicy(InMemoryPolicyStore);

impl PolicyStore for UnreadableAppPolicy {
    fn project<'a>(&'a self, project_id: &'a str) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        self.0.project(project_id)
    }

    fn app(&self) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        Box::pin(async { Err(PolicyRefusal::ReadOnly) })
    }

    fn apply_project<'a>(
        &'a self,
        project_id: &'a str,
        expected_revision: u64,
        op: ProjectPolicyOp,
    ) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        self.0.apply_project(project_id, expected_revision, op)
    }

    fn apply_app(&self, expected_revision: u64, op: AppPolicyOp) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        self.0.apply_app(expected_revision, op)
    }
}

fn unasked(
    outcomes: impl IntoIterator<Item = TicketOutcome>,
) -> (Arc<ScriptedPermissions>, Arc<InMemoryPolicyStore>, ConsentGate) {
    let perms = Arc::new(ScriptedPermissions::answering(outcomes));
    let store = Arc::new(InMemoryPolicyStore::opening_sites_unasked());
    let gate = ConsentGate::new(perms.clone(), store.clone());
    (perms, store, gate)
}

#[tokio::test]
async fn with_the_default_policy_public_and_lan_sites_open_without_a_prompt() {
    let (perms, _store, gate) = unasked([]);
    for url in ["https://new.example/", "http://192.168.1.1/", "http://10.0.0.5:8080/admin"] {
        authorize(&gate, "s1", url).await.unwrap_or_else(|e| panic!("{url}: {e}"));
    }
    assert!(perms.requests.lock().is_empty(), "no prompt for new sites");
    let opened: Url = "https://new.example/".parse().unwrap();
    assert!(
        !gate.vouched_for("s1", &opened, TabProfile::Ephemeral),
        "a site opened without a prompt is not vouched for"
    );
    assert!(gate.opened_unasked("s1", &opened));
}

#[tokio::test]
async fn hard_denies_stay_hard_with_the_site_prompt_off() {
    let (perms, _store, gate) = unasked([]);
    for (url, reason) in [
        ("http://169.254.169.254/latest", "metadata_address"),
        ("http://0.0.0.0:3000/", "unspecified_address"),
        ("http://tauri.localhost/", "app_origin"),
        ("ftp://files.example/", "scheme_not_allowed"),
    ] {
        let err = authorize(&gate, "s1", url).await.unwrap_err();
        assert_eq!(code_reason(&err), ("invalid_params", Some(reason)), "{url}");
    }
    let owned = crate::host_perimeter::OwnedPort::claim(61_391);
    let err = authorize(&gate, "s1", "http://127.0.0.1:61391/").await.unwrap_err();
    assert_eq!(code_reason(&err), ("invalid_params", Some("troupe_owned_origin")));
    drop(owned);
    assert!(perms.requests.lock().is_empty());
}

#[tokio::test]
async fn the_stop_latch_holds_with_the_site_prompt_off() {
    let (_perms, _store, gate) = unasked([]);
    assert!(gate.stop("s1"));
    let err = authorize(&gate, "s1", "https://new.example/").await.unwrap_err();
    assert_eq!(code_reason(&err), ("confirmation_required", Some("stopped_by_user")));
}

#[tokio::test]
async fn turning_the_switch_on_mid_session_prompts_on_the_next_call() {
    let (perms, store, gate) = unasked([]);
    authorize(&gate, "s1", "https://new.example/").await.unwrap();
    assert!(perms.requests.lock().is_empty());
    store
        .apply_app(0, AppPolicyOp::SetAskBeforeOpeningSites(true))
        .await
        .unwrap();
    let err = authorize(&gate, "s1", "https://new.example/").await.unwrap_err();
    assert_eq!(code_reason(&err), ("confirmation_required", Some("unattended")));
    assert_eq!(perms.requests.lock().len(), 1, "the unlisted site prompts again");
    let lan = authorize(&gate, "s1", "http://192.168.1.1/").await.unwrap_err();
    assert_eq!(code_reason(&lan), ("confirmation_required", Some("unattended")));
    assert_eq!(perms.requests.lock()[1].0.action, ActionClass::LocalNetwork);
}

#[tokio::test]
async fn an_unreadable_app_policy_asks_before_opening_sites() {
    let perms = Arc::new(ScriptedPermissions::default());
    let store = Arc::new(UnreadableAppPolicy(InMemoryPolicyStore::opening_sites_unasked()));
    let gate = ConsentGate::new(perms.clone(), store);
    let err = authorize(&gate, "s1", "https://new.example/").await.unwrap_err();
    assert_eq!(code_reason(&err), ("confirmation_required", Some("unattended")));
    assert_eq!(perms.requests.lock().len(), 1);
}

/// The URL of `rel` under the temp folder: a local path on any host.
fn file_url_of(rel: &str) -> Url {
    Url::from_file_path(std::env::temp_dir().join(rel)).unwrap()
}

fn local_file(rel: &str, inside: bool) -> LocalFile {
    let real = std::env::temp_dir().join(rel);
    let url = file_url_of(rel);
    LocalFile {
        read_access: real.clone(),
        real,
        url,
        inside,
    }
}

async fn open_file(gate: &ConsentGate, session_id: &str, file: &LocalFile) -> Result<(), BrowserError> {
    let token = gate.begin(session_id)?;
    let url = file.url.to_string();
    let request = req(session_id, &url);
    let outcome = token.guard(gate.authorize_file(&token, &request, file)).await;
    outcome
}

#[tokio::test]
async fn a_project_file_opens_without_a_prompt_and_is_granted_exactly() {
    let (perms, _store, gate) = scripted([]);
    let file = local_file("proj/dist/index.html", true);
    open_file(&gate, "s1", &file).await.unwrap();
    assert!(perms.requests.lock().is_empty());
    assert_eq!(gate.check_hop("s1", &file.url), HopVerdict::Allow);
    let sibling = file_url_of("proj/dist/other.html");
    assert_eq!(
        gate.check_hop("s1", &sibling),
        HopVerdict::Deny(DenyReason::FileNotGranted),
        "the grant names one file, never its folder"
    );
    assert!(!gate.vouched_for("s1", &file.url, TabProfile::Ephemeral), "files are never vouched for");
}

#[tokio::test]
async fn a_file_outside_the_project_asks_once_or_deny_each_time() {
    let (perms, _store, gate) = scripted([
        TicketOutcome::Answered(ConsentOption::AllowSession),
        TicketOutcome::Answered(ConsentOption::Deny),
    ]);
    let file = local_file("notes/a.html", false);
    open_file(&gate, "s1", &file).await.unwrap();
    assert_eq!(gate.check_hop("s1", &file.url), HopVerdict::Allow);
    {
        let requests = perms.requests.lock();
        let ticket = &requests[0].0;
        assert_eq!(ticket.options, &ConsentOption::ONCE_OR_DENY[..]);
        assert!(matches!(ticket.origin, TicketTarget::File(_)));
        assert_eq!(ticket.origin.kind(), "file");
        assert_eq!(ticket.target_url, file_url_of("notes/a.html").to_string());
        assert_eq!(ticket.action, ActionClass::Navigate);
    }
    let err = open_file(&gate, "s1", &file).await.unwrap_err();
    assert_eq!(code_reason(&err), ("confirmation_required", Some("denied_by_user")));
    assert_eq!(perms.requests.lock().len(), 2, "opening it again asks again");
}

#[tokio::test]
async fn an_outside_file_with_no_approver_is_confirmation_required() {
    let (_perms, _store, gate) = scripted([]);
    let file = local_file("notes/a.html", false);
    let err = open_file(&gate, "s1", &file).await.unwrap_err();
    assert_eq!(code_reason(&err), ("confirmation_required", Some("unattended")));
    assert_eq!(gate.check_hop("s1", &file.url), HopVerdict::Deny(DenyReason::FileNotGranted));
}

#[tokio::test]
async fn a_session_that_opens_a_file_first_still_opens_web_links_unasked() {
    let (_perms, _store, gate) = unasked([]);
    let file = local_file("proj/index.html", true);
    open_file(&gate, "s1", &file).await.unwrap();
    let link: Url = "https://docs.example/".parse().unwrap();
    assert_eq!(
        gate.check_hop("s1", &link),
        HopVerdict::Allow,
        "opening the file snapshotted the site switch too"
    );
}

#[tokio::test]
async fn stop_revokes_file_grants() {
    let (_perms, _store, gate) = scripted([]);
    let file = local_file("proj/index.html", true);
    open_file(&gate, "s1", &file).await.unwrap();
    gate.stop("s1");
    assert_eq!(gate.check_hop("s1", &file.url), HopVerdict::Deny(DenyReason::FileNotGranted));
    assert_eq!(gate.file_read_access("s1", &file.url), None);
}
