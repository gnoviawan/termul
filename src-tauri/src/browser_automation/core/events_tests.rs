use super::*;
use crate::browser_automation::engine::events::{CommitKind, NavVerdict};

const AGENT: &str = "agent-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d";
const USER: &str = "tab-2d9e4f30-7182-4c3d-9e4f-5a6b7c8d9e0f";

fn registry_with_live_tabs() -> TabRegistry {
    let mut registry = TabRegistry::default();
    let _opened = registry.expect_agent_tab(AGENT, "s1", "https://example.com/", crate::browser_automation::core::ports::TabProfile::Global)
        .unwrap();
    registry.begin_create(AGENT, "").unwrap();
    registry.finish_create(AGENT);
    registry.begin_create(USER, "https://user.test/").unwrap();
    registry.finish_create(USER);
    registry
}

fn updated(applied: Applied) -> TabView {
    match applied {
        Applied::Projected {
            projection: TabProjection::Updated(view),
            ..
        } => view,
        other => panic!("expected an update, got {other:?}"),
    }
}

#[test]
fn engine_events_become_the_tab_state_the_renderer_mirrors() {
    let mut registry = registry_with_live_tabs();
    let starting = TabEvent::NavStarting {
        nav_id: 1,
        url: "https://example.com/".to_string(),
        verdict: NavVerdict::Allow,
    };
    assert!(updated(apply(&mut registry, AGENT, starting)).loading);
    let committed = TabEvent::NavCommitted {
        nav_id: Some(1),
        kind: CommitKind::NewDocument,
        url: "https://example.com/".to_string(),
    };
    apply(&mut registry, AGENT, committed);
    let title = TabEvent::TitleChanged {
        title: "Example Domain".to_string(),
    };
    apply(&mut registry, AGENT, title);
    let view = updated(apply(&mut registry, AGENT, TabEvent::LoadFinished));
    assert_eq!(
        view,
        TabView {
            tab_id: AGENT.to_string(),
            url: "https://example.com/".to_string(),
            title: "Example Domain".to_string(),
            loading: false,
            agent_controlled: true,
            epoch: 1,
        }
    );
}

#[test]
fn agent_tab_projections_name_their_session() {
    let mut registry = registry_with_live_tabs();
    let applied = apply(
        &mut registry,
        AGENT,
        TabEvent::TitleChanged {
            title: "t".to_string(),
        },
    );
    assert!(matches!(applied, Applied::Projected { session: Some(ref s), .. } if s == "s1"));
    let applied = apply(
        &mut registry,
        USER,
        TabEvent::TitleChanged {
            title: "t".to_string(),
        },
    );
    assert!(matches!(applied, Applied::Projected { session: None, .. }));
}

#[test]
fn a_user_tab_load_runs_page_load_extras_and_an_agent_tab_load_does_not() {
    let mut registry = registry_with_live_tabs();
    assert!(matches!(
        apply(&mut registry, USER, TabEvent::LoadFinished),
        Applied::UserPageLoaded(_)
    ));
    assert!(matches!(
        apply(&mut registry, AGENT, TabEvent::LoadFinished),
        Applied::Projected { .. }
    ));
}

#[test]
fn closed_drops_the_record_once_and_unknown_tabs_are_ignored() {
    let mut registry = registry_with_live_tabs();
    assert_eq!(
        apply(&mut registry, AGENT, TabEvent::Closed),
        Applied::Projected {
            projection: TabProjection::Closed {
                tab_id: AGENT.to_string()
            },
            session: Some("s1".to_string()),
        }
    );
    assert!(registry.get(AGENT).is_none());
    assert_eq!(
        apply(&mut registry, AGENT, TabEvent::Closed),
        Applied::Ignored
    );
    assert_eq!(
        apply(&mut registry, AGENT, TabEvent::LoadFinished),
        Applied::Ignored
    );
}

#[test]
fn log_lines_carry_only_a_label_prefix() {
    assert_eq!(label_prefix(AGENT), "agent-0b7c2d1e");
    assert_eq!(label_prefix("short"), "short");
}
