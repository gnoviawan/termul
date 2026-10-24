use super::*;
use crate::browser_automation::ERR_TAB_NOT_FOUND;

const AGENT_A: &str = "agent-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d";
const AGENT_B: &str = "agent-1c8d3e2f-6071-4b2c-8d3e-4f5a6b7c8d9e";
const USER: &str = "tab-2d9e4f30-7182-4c3d-9e4f-5a6b7c8d9e0f";

fn node(role: &str, name: &str, path: &str) -> RefNode {
    RefNode {
        role: role.to_string(),
        name: name.to_string(),
        path: path.to_string(),
        frame: String::new(),
    }
}

/// An agent tab the host asked for and the engine confirmed, with the
/// opener's first-navigation waiter.
fn live_agent_tab(
    registry: &mut TabRegistry,
    label: &str,
    session: &str,
) -> oneshot::Receiver<NavOutcome> {
    let mut opened = registry.expect_agent_tab(label, session, "https://example.com/", TabProfile::Global)
        .unwrap();
    assert_eq!(
        registry.begin_create(label, "ignored"),
        Ok(FirstLoad::ViaBlank("https://example.com/".to_string()))
    );
    assert!(registry.finish_create(label));
    opened
        .try_recv()
        .expect("the opener hears the tab is live")
        .expect("created")
}

#[test]
fn labels_parse_only_in_their_canonical_form() {
    assert_eq!(parse_label(USER), Some(LabelKind::User));
    assert_eq!(parse_label(AGENT_A), Some(LabelKind::Agent));
    assert_eq!(parse_label(&mint_agent_label()), Some(LabelKind::Agent));
    for bad in [
        "",
        "main",
        "tab-",
        "agent-1",
        "agent-someone-else",
        "tab-2D9E4F30-7182-4C3D-9E4F-5A6B7C8D9E0F",
        "tab-2d9e4f3071824c3d9e4f5a6b7c8d9e0f",
        "browser-2d9e4f30-7182-4c3d-9e4f-5a6b7c8d9e0f",
    ] {
        assert_eq!(parse_label(bad), None, "{bad:?}");
    }
}

#[test]
fn the_renderer_cannot_create_a_tab_the_registry_did_not_admit() {
    let mut registry = TabRegistry::default();
    assert_eq!(
        registry.begin_create("browser-1", "https://a.test/"),
        Err(CreateRefusal::Malformed)
    );
    assert_eq!(
        registry.begin_create(AGENT_A, "https://a.test/"),
        Err(CreateRefusal::UnknownAgentTab),
        "an agent label nobody asked for"
    );
    assert_eq!(
        registry.begin_create(USER, "https://a.test/"),
        Ok(FirstLoad::Direct("https://a.test/".to_string()))
    );
    assert_eq!(
        registry.begin_create(USER, "https://a.test/"),
        Err(CreateRefusal::AlreadyExists)
    );
}

#[test]
fn an_explicit_tab_id_resolves_only_to_a_live_agent_tab_of_the_same_session() {
    let mut registry = TabRegistry::default();
    let _first_nav = live_agent_tab(&mut registry, AGENT_A, "s1");
    let _foreign = live_agent_tab(&mut registry, AGENT_B, "s2");
    registry.begin_create(USER, "https://a.test/").unwrap();
    registry.finish_create(USER);

    assert_eq!(
        registry.resolve("s1", Some(AGENT_A)).unwrap().as_deref(),
        Some(AGENT_A)
    );
    for bad in [AGENT_B, USER, "agent-unknown", "not a label"] {
        let err = registry.resolve("s1", Some(bad)).expect_err(bad);
        assert_eq!(err.code, ERR_TAB_NOT_FOUND, "{bad}");
        assert_eq!(err.arg_keys, ["tabId"]);
    }
    assert_eq!(
        registry.resolve("s1", None).unwrap().as_deref(),
        Some(AGENT_A)
    );
    assert_eq!(
        registry.resolve("s3", None).unwrap(),
        None,
        "a session with no tab"
    );
}

#[test]
fn a_tab_still_being_built_is_not_resolvable() {
    let mut registry = TabRegistry::default();
    let _opened = registry.expect_agent_tab(AGENT_A, "s1", "https://example.com/", TabProfile::Global)
        .unwrap();
    registry.begin_create(AGENT_A, "").unwrap();
    assert!(registry.resolve("s1", Some(AGENT_A)).is_err());
    assert_eq!(registry.resolve("s1", None).unwrap(), None);
    assert!(registry.wait_for_navigation(AGENT_A).is_none());
}

#[test]
fn the_default_tab_is_the_first_opened_and_moves_to_the_oldest_survivor() {
    let mut registry = TabRegistry::default();
    let _a = live_agent_tab(&mut registry, AGENT_A, "s1");
    let _b = live_agent_tab(&mut registry, AGENT_B, "s1");
    assert_eq!(registry.default_tab("s1"), Some(AGENT_A));
    assert_eq!(registry.owned("s1"), [AGENT_A, AGENT_B]);

    assert!(registry.begin_close(AGENT_A));
    assert!(!registry.begin_close(AGENT_A), "closing twice is a no-op");
    registry.remove(AGENT_A);
    assert_eq!(registry.default_tab("s1"), Some(AGENT_B));
    registry.remove(AGENT_B);
    assert_eq!(registry.default_tab("s1"), None);
}

#[test]
fn the_first_navigation_completes_on_its_commit_with_epoch_one() {
    let mut registry = TabRegistry::default();
    let mut first_nav = live_agent_tab(&mut registry, AGENT_A, "s1");
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(1, NavVerdict::Allow);
    assert!(first_nav.try_recv().is_err(), "a start hop is not a commit");
    record.committed(Some(1), CommitKind::NewDocument, "https://example.com/");
    assert_eq!(first_nav.try_recv(), Ok(NavOutcome::Committed { epoch: 1 }));
}

#[test]
fn every_new_document_commit_bumps_the_epoch_and_same_document_ones_do_not() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(1, NavVerdict::Allow);
    record.committed(Some(1), CommitKind::NewDocument, "https://example.com/");
    // A link the user clicked, then a page-script `location.assign`.
    for (hop, url) in [
        (2, "https://example.com/clicked"),
        (3, "https://example.com/scripted"),
    ] {
        record.nav_starting(hop, NavVerdict::Allow);
        record.committed(Some(hop), CommitKind::NewDocument, url);
    }
    assert_eq!(
        (record.epoch, record.url.as_str()),
        (3, "https://example.com/scripted")
    );
    record.committed(
        None,
        CommitKind::SameDocument,
        "https://example.com/scripted#pushed",
    );
    assert_eq!(
        (record.epoch, record.url.as_str()),
        (3, "https://example.com/scripted#pushed"),
        "pushState moves the URL, not the epoch"
    );
}

#[test]
fn a_redirect_chain_completes_on_the_final_commit() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    let mut nav = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(1, NavVerdict::Allow);
    record.nav_starting(2, NavVerdict::Allow);
    assert!(nav.try_recv().is_err(), "a redirect hop is not a commit");
    record.committed(
        Some(2),
        CommitKind::NewDocument,
        "https://example.com/final",
    );
    assert_eq!(nav.try_recv(), Ok(NavOutcome::Committed { epoch: 1 }));
    assert_eq!(record.url, "https://example.com/final");
}

#[test]
fn a_navigation_ignores_commits_of_hops_that_started_before_it() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    registry
        .get_mut(AGENT_A)
        .unwrap()
        .nav_starting(1, NavVerdict::Allow);
    let mut nav = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.committed(
        Some(1),
        CommitKind::NewDocument,
        "https://example.com/earlier",
    );
    assert!(
        nav.try_recv().is_err(),
        "that commit belongs to someone else"
    );
    record.nav_starting(2, NavVerdict::Allow);
    record.committed(Some(2), CommitKind::NewDocument, "https://example.com/mine");
    assert_eq!(nav.try_recv(), Ok(NavOutcome::Committed { epoch: 2 }));
}

#[test]
fn a_same_document_commit_finishes_only_a_navigation_without_a_start_hop() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    let mut back = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.committed(None, CommitKind::SameDocument, "https://example.com/#a");
    assert_eq!(
        back.try_recv(),
        Ok(NavOutcome::Committed { epoch: 0 }),
        "history step inside the page"
    );

    let mut nav = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(1, NavVerdict::Allow);
    record.committed(
        None,
        CommitKind::SameDocument,
        "https://example.com/#script",
    );
    assert!(
        nav.try_recv().is_err(),
        "page script during a real navigation does not finish it"
    );
    record.committed(Some(1), CommitKind::NewDocument, "https://example.com/next");
    assert_eq!(nav.try_recv(), Ok(NavOutcome::Committed { epoch: 1 }));
}

#[test]
fn a_denied_hop_ends_the_navigation_and_a_load_without_commit_ends_it_too() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    let mut denied = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(1, NavVerdict::Allow);
    record.nav_starting(2, NavVerdict::Deny);
    assert_eq!(denied.try_recv(), Ok(NavOutcome::Denied));

    let mut fragment = registry.wait_for_navigation(AGENT_A).unwrap();
    let record = registry.get_mut(AGENT_A).unwrap();
    record.nav_starting(3, NavVerdict::Allow);
    record.load_finished();
    assert_eq!(fragment.try_recv(), Ok(NavOutcome::Committed { epoch: 0 }));
    assert!(!record.loading);
}

#[test]
fn closing_a_tab_ends_its_waiters_and_a_failed_create_tells_the_opener() {
    let mut registry = TabRegistry::default();
    let _first = live_agent_tab(&mut registry, AGENT_A, "s1");
    let mut nav = registry.wait_for_navigation(AGENT_A).unwrap();
    registry.begin_close(AGENT_A);
    assert_eq!(nav.try_recv(), Ok(NavOutcome::Closed));

    let mut opened = registry.expect_agent_tab(AGENT_B, "s1", "https://example.com/", TabProfile::Global)
        .unwrap();
    registry.begin_create(AGENT_B, "").unwrap();
    registry.fail_create(AGENT_B, "the browser engine did not create the tab");
    assert_eq!(
        opened.try_recv().unwrap().err().as_deref(),
        Some("the browser engine did not create the tab")
    );
    assert!(
        registry.get(AGENT_B).is_none(),
        "a refused tab leaves no record"
    );
}

#[test]
fn a_session_in_teardown_gets_no_new_tab() {
    let mut registry = TabRegistry::default();
    let mut pending = registry.expect_agent_tab(AGENT_A, "s1", "https://example.com/", TabProfile::Global)
        .unwrap();
    registry.begin_session_teardown("s1");
    assert!(registry.is_closing("s1"));
    assert_eq!(
        pending.try_recv().unwrap().err().as_deref(),
        Some("the session ended")
    );
    assert_eq!(
        registry.begin_create(AGENT_A, ""),
        Err(CreateRefusal::UnknownAgentTab)
    );
    registry.end_session_teardown("s1");
    assert!(!registry.is_closing("s1"));
}

#[test]
fn refs_from_an_older_document_or_snapshot_are_stale() {
    let mut refs = TabRefs::default();
    let first = refs.mint_snapshot(
        1,
        vec![node("button", "Go", "@e1"), node("link", "Docs", "@e2")],
    );
    assert_eq!(first, ["@e1", "@e2"]);
    assert_eq!(refs.resolve("@e2", 1).unwrap().path, "@e2");

    let again = refs.mint_snapshot(
        1,
        vec![node("link", "Docs", "@e2"), node("link", "New", "@e3")],
    );
    assert_eq!(
        again,
        ["@e2", "@e3"],
        "an identical node keeps its ref within the epoch"
    );
    assert_eq!(refs.resolve("@e1", 1).err(), Some(RefStale::Superseded));

    let next_doc = refs.mint_snapshot(2, vec![node("button", "Go", "@e1")]);
    assert_eq!(next_doc, ["@e4"], "refs are never reused across documents");
    assert_eq!(refs.resolve("@e2", 2).err(), Some(RefStale::OlderDocument));
    assert_eq!(
        refs.resolve("@e4", 3).err(),
        Some(RefStale::OlderDocument),
        "the tab moved on"
    );
    assert_eq!(refs.resolve("@e99", 2).err(), Some(RefStale::Unknown));
    assert_eq!(refs.resolve("e4", 2).err(), Some(RefStale::Unknown));
}

#[test]
fn nodes_sharing_a_role_and_name_each_resolve_to_their_own_path() {
    let mut refs = TabRefs::default();
    let minted = refs.mint_snapshot(
        1,
        vec![
            node("button", "Delete", "p1"),
            node("button", "Delete", "p2"),
            node("textbox", "", "p3"),
            node("textbox", "", "p4"),
        ],
    );
    assert_eq!(minted, ["@e1", "@e2", "@e3", "@e4"]);
    let paths: Vec<&str> = minted.iter().map(|t| refs.resolve(t, 1).unwrap().path.as_str()).collect();
    assert_eq!(paths, ["p1", "p2", "p3", "p4"]);
}
