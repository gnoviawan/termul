use std::sync::atomic::AtomicBool;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::*;

const VISIT: &str = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ";

#[test]
fn the_sign_in_link_is_the_closed_https_token_after_visit() {
    assert_eq!(
        sign_in_link(VISIT),
        Some("https://claude.com/cai/oauth/authorize?code=true&state=abc")
    );
    assert_eq!(
        sign_in_link("visit: https://claude.com/cai/oauth/authorize?code=tr"),
        None,
        "a link the next read may still extend"
    );
    assert_eq!(sign_in_link("Opening browser to sign in…\n"), None);
    assert_eq!(
        sign_in_link("See https://docs.example/x for help.\nvisit: https://claude.com/a\n"),
        Some("https://claude.com/a"),
        "only the link on the visit line"
    );
}

#[test]
fn only_the_cli_complaint_about_a_cut_code_counts_as_incomplete() {
    assert!(reports_incomplete_code(
        "Invalid code. Please make sure the full code was copied.\n"
    ));
    assert!(!reports_incomplete_code(
        "Login failed: Request failed with status code 400\n"
    ));
}

#[test]
fn the_kept_output_is_the_latest_64_kib_and_still_finds_the_link_and_verdict() {
    let mut output = String::new();
    keep_tail(&mut output, &"é".repeat(MAX_OUTPUT_BYTES));
    assert!(output.len() <= MAX_OUTPUT_BYTES);
    assert!(output.len() > MAX_OUTPUT_BYTES - 2, "{}", output.len());
    assert!(
        output.chars().all(|c| c == 'é'),
        "cut on a character boundary"
    );

    keep_tail(&mut output, VISIT);
    assert!(output.len() <= MAX_OUTPUT_BYTES);
    assert_eq!(
        sign_in_link(&output),
        Some("https://claude.com/cai/oauth/authorize?code=true&state=abc")
    );

    keep_tail(&mut output, &"x".repeat(MAX_OUTPUT_BYTES * 3));
    keep_tail(
        &mut output,
        "Invalid code. Please make sure the full code was copied.\n",
    );
    assert!(output.len() <= MAX_OUTPUT_BYTES);
    assert!(reports_incomplete_code(&output));
}

#[test]
fn a_pasted_code_loses_whitespace_and_must_be_printable() {
    assert_eq!(
        LoginCode::parse("  abc#def\n"),
        Some(LoginCode("abc#def".into()))
    );
    assert_eq!(
        LoginCode::parse("abc\n#def"),
        Some(LoginCode("abc#def".into()))
    );
    assert_eq!(LoginCode::parse(" \n "), None);
    assert_eq!(LoginCode::parse("abc\u{1b}#def"), None);
    assert_eq!(LoginCode::parse(&"a".repeat(MAX_CODE_CHARS + 1)), None);
}

fn awaiting_link() -> (Phase, oneshot::Receiver<Result<String, String>>) {
    let (reply, link) = oneshot::channel();
    let phase = Phase::AwaitingLink {
        output: String::new(),
        until: Instant::now(),
        reply,
    };
    (phase, link)
}

fn submission(code: &str) -> (CodeSubmission, oneshot::Receiver<Result<(), LinkCodeError>>) {
    let (reply, verdict) = oneshot::channel();
    let code = LoginCode::parse(code).unwrap();
    (CodeSubmission { code, reply }, verdict)
}

/// A session that handed out its link and got `code`: the phase it checks in.
fn checking(code: &str) -> (Phase, oneshot::Receiver<Result<(), LinkCodeError>>) {
    let (submitted, verdict) = submission(code);
    let Step { next, write } = step(Phase::AwaitingCode, Event::Code(submitted), Instant::now());
    assert_eq!(
        write,
        Some(LoginCode(code.into())),
        "the code goes to the CLI"
    );
    (next.expect("checking"), verdict)
}

#[test]
fn the_link_is_handed_out_once_its_line_is_complete() {
    let (phase, mut link) = awaiting_link();
    let (first, second) = VISIT.split_at(70);
    let Step { next, .. } = step(phase, Event::Output(first.into()), Instant::now());
    assert!(link.try_recv().is_err(), "no link yet");
    let Step { next, .. } = step(next.unwrap(), Event::Output(second.into()), Instant::now());
    assert!(matches!(next, Some(Phase::AwaitingCode)));
    assert_eq!(
        link.try_recv().unwrap(),
        Ok("https://claude.com/cai/oauth/authorize?code=true&state=abc".into())
    );
}

#[test]
fn no_link_before_the_cli_stops_or_the_wait_ends_is_an_error() {
    for event in [Event::Exited { success: false }, Event::TimedOut] {
        let (phase, mut link) = awaiting_link();
        assert!(step(phase, event, Instant::now()).next.is_none());
        assert_eq!(link.try_recv().unwrap(), Err(NO_LINK.into()));
    }
    let (phase, mut link) = awaiting_link();
    assert!(step(phase, Event::Cancelled, Instant::now()).next.is_none());
    assert_eq!(link.try_recv().unwrap(), Err(LOGIN_CANCELLED.into()));
}

#[test]
fn an_incomplete_code_keeps_the_session_waiting_for_another() {
    let (phase, mut verdict) = checking("abc");
    let complaint =
        Event::Output("Invalid code. Please make sure the full code was copied.\n".into());
    let Step { next, write } = step(phase, complaint, Instant::now());
    assert!(matches!(next, Some(Phase::AwaitingCode)));
    assert_eq!(write, None);
    assert_eq!(verdict.try_recv().unwrap(), Err(LinkCodeError::Incomplete));
}

#[test]
fn the_cli_exit_decides_a_complete_code() {
    let (phase, mut verdict) = checking("abc#def");
    let Step { next, .. } = step(phase, Event::Exited { success: true }, Instant::now());
    assert!(next.is_none());
    assert_eq!(verdict.try_recv().unwrap(), Ok(()));

    let (phase, mut verdict) = checking("abc#def");
    let failed = Event::Output("Login failed: Request failed with status code 400\n".into());
    let Step { next, .. } = step(phase, failed, Instant::now());
    let Step { next, .. } = step(
        next.unwrap(),
        Event::Exited { success: false },
        Instant::now(),
    );
    assert!(next.is_none());
    assert_eq!(verdict.try_recv().unwrap(), Err(ended(CODE_REJECTED)));
}

#[test]
fn a_check_that_times_out_or_is_cancelled_ends_the_session() {
    for (event, message) in [
        (Event::TimedOut, CODE_UNANSWERED),
        (Event::Cancelled, LOGIN_CANCELLED),
    ] {
        let (phase, mut verdict) = checking("abc#def");
        assert!(step(phase, event, Instant::now()).next.is_none());
        assert_eq!(verdict.try_recv().unwrap(), Err(ended(message)));
    }
}

#[test]
fn a_code_before_the_link_or_during_a_check_is_turned_away() {
    let (phase, _link) = awaiting_link();
    let (early, mut verdict) = submission("abc#def");
    let Step { next, write } = step(phase, Event::Code(early), Instant::now());
    assert!(matches!(next, Some(Phase::AwaitingLink { .. })));
    assert_eq!(write, None);
    assert_eq!(verdict.try_recv().unwrap(), Err(ended(CODE_EARLY)));

    let (phase, mut first) = checking("abc#def");
    let (second, mut turned_away) = submission("ghi#jkl");
    let Step { next, write } = step(phase, Event::Code(second), Instant::now());
    assert!(matches!(next, Some(Phase::Checking { .. })));
    assert_eq!(write, None);
    assert_eq!(turned_away.try_recv().unwrap(), Err(LinkCodeError::Busy));
    assert!(
        first.try_recv().is_err(),
        "the first code is still being checked"
    );
}

#[test]
fn a_new_sign_in_replaces_the_running_one_and_its_end_keeps_the_new_one() {
    let logins = Logins::default();
    let (cancel, mut browser) = oneshot::channel();
    let first = logins.begin("ab12", LoginKind::Browser { _cancel: cancel });
    let (codes, mut link) = mpsc::channel(1);
    let second = logins.begin("ab12", LoginKind::Link(codes));

    assert!(browser
        .try_recv()
        .is_err_and(|error| error == oneshot::error::TryRecvError::Closed));
    logins.end("ab12", first);
    assert!(
        logins.link("ab12").is_some(),
        "a stale end leaves the new sign-in"
    );
    logins.end("ab12", second);
    assert!(logins.link("ab12").is_none());
    assert!(link
        .try_recv()
        .is_err_and(|error| error == mpsc::error::TryRecvError::Disconnected));
}

#[tokio::test]
async fn stop_waits_until_the_sign_in_has_let_go_of_its_cli() {
    let logins = Arc::new(Logins::default());
    assert!(!logins.stop("ab12").await);
    let (codes, mut link) = mpsc::channel(1);
    let ticket = logins.begin("ab12", LoginKind::Link(codes));
    let cli_gone = Arc::new(AtomicBool::new(false));
    let session = {
        let (logins, cli_gone) = (Arc::clone(&logins), Arc::clone(&cli_gone));
        tokio::spawn(async move {
            assert!(link.recv().await.is_none(), "stop closes the code channel");
            // The CLI takes a moment to exit after the kill.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            cli_gone.store(true, Ordering::SeqCst);
            logins.end("ab12", ticket);
        })
    };
    assert!(logins.stop("ab12").await);
    assert!(
        cli_gone.load(Ordering::SeqCst),
        "stop answered before the CLI was gone"
    );
    assert!(!logins.stop("ab12").await);
    session.await.unwrap();
}

#[tokio::test]
async fn removing_an_account_waits_until_its_sign_in_cli_is_gone() {
    let root = tempfile::tempdir().unwrap();
    let service = ClaudeAgentService::with_logins_for_test(root.path(), &[]);
    let account = service.add_account("Work").unwrap();
    let (codes, mut link) = mpsc::channel(1);
    let ticket = service.logins.begin(&account.id, LoginKind::Link(codes));
    let (stopped, saw_stop) = oneshot::channel();
    let (exit, cli_exits) = oneshot::channel::<()>();
    let session = {
        let logins = Arc::clone(&service.logins);
        let id = account.id.clone();
        tokio::spawn(async move {
            assert!(link.recv().await.is_none(), "the removal stops the sign-in");
            stopped.send(()).unwrap();
            let _ = cli_exits.await;
            logins.end(&id, ticket);
        })
    };

    let remove = service.remove_account(&account.id);
    tokio::pin!(remove);
    tokio::select! {
        _ = &mut remove => panic!("the removal finished without stopping the sign-in"),
        _ = saw_stop => {}
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), &mut remove)
            .await
            .is_err(),
        "the removal went on while the sign-in's CLI still ran"
    );
    assert!(service.has_account(&account.id).unwrap());

    exit.send(()).unwrap();
    remove.await.unwrap();
    session.await.unwrap();
    assert!(!service.has_account(&account.id).unwrap());
}

#[tokio::test]
async fn a_code_with_no_link_sign_in_waiting_says_to_start_again() {
    let root = tempfile::tempdir().unwrap();
    let service = ClaudeAgentService::with_logins_for_test(root.path(), &[]);
    assert_eq!(
        service.finish_link_login("default", "abc#def").await,
        Err(ended(NO_LINK_LOGIN))
    );
    assert_eq!(
        service.finish_link_login("default", "  \n").await,
        Err(LinkCodeError::Incomplete),
        "a blank paste is checked before anything else"
    );
}

/// Runs the real `claude auth login` against a temp config dir. Needs the
/// Claude Code CLI on PATH and network access to claude.com.
#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn the_real_cli_hands_out_a_link_and_judges_pasted_codes() {
    let root = tempfile::tempdir().unwrap();
    let service = ClaudeAgentService::with_logins_for_test(root.path(), &[]);
    let account = service.add_account("Probe").unwrap();

    let link = service.start_link_login(&account.id).await.unwrap();
    assert!(link.starts_with("https://claude.com/"), "{}", link.len());
    assert!(link.contains("oauth/authorize"));

    assert_eq!(
        service.finish_link_login(&account.id, "nohash").await,
        Err(LinkCodeError::Incomplete)
    );
    assert_eq!(
        service.finish_link_login(&account.id, "x#y").await,
        Err(ended(CODE_REJECTED)),
        "the session survived the incomplete code"
    );
    assert_eq!(
        service.finish_link_login(&account.id, "x#y").await,
        Err(ended(NO_LINK_LOGIN)),
        "a rejected code ends the session"
    );

    service.start_link_login(&account.id).await.unwrap();
    assert!(service.cancel_login(&account.id).await);
    assert_eq!(
        service.finish_link_login(&account.id, "x#y").await,
        Err(ended(NO_LINK_LOGIN))
    );
}
