use super::super::{mint_agent_label, FirstLoad};
use super::*;

const OPENER: &str = "agent-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d";

fn live(registry: &mut TabRegistry, label: &str) {
    assert!(registry.begin_create(label, "ignored").is_ok());
    assert!(registry.finish_create(label));
}

fn registry_with_opener() -> TabRegistry {
    let mut registry = TabRegistry::default();
    registry
        .expect_agent_tab(OPENER, "s1", "https://example.com/", TabProfile::Ephemeral)
        .unwrap();
    live(&mut registry, OPENER);
    registry
}

#[test]
fn a_popup_runs_on_the_opener_session_and_profile_and_never_becomes_default() {
    let mut registry = registry_with_opener();
    let popup = mint_agent_label();
    registry
        .expect_popup_tab(&popup, OPENER, "https://example.com/pop")
        .unwrap();
    assert_eq!(
        registry.begin_create(&popup, "ignored"),
        Ok(FirstLoad::ViaBlank("https://example.com/pop".to_string()))
    );
    assert!(registry.finish_create(&popup));
    let record = registry.get(&popup).unwrap();
    assert_eq!(record.popup_of.as_deref(), Some(OPENER));
    assert_eq!(
        (record.session_id(), record.profile()),
        (Some("s1"), Some(TabProfile::Ephemeral))
    );
    assert_eq!(registry.default_tab("s1"), Some(OPENER));

    registry.begin_close(OPENER);
    registry.remove(OPENER);
    assert_eq!(
        registry.default_tab("s1"),
        None,
        "a popup is not promoted to the default"
    );
    assert_eq!(registry.session_popups("s1"), vec![popup]);
}

#[test]
fn a_session_holds_at_most_three_popups_opening_or_open() {
    let mut registry = registry_with_opener();
    let first = mint_agent_label();
    registry
        .expect_popup_tab(&first, OPENER, "https://example.com/1")
        .unwrap();
    live(&mut registry, &first);
    for n in 2..=MAX_OPEN_POPUPS {
        registry
            .expect_popup_tab(
                &mint_agent_label(),
                OPENER,
                &format!("https://example.com/{n}"),
            )
            .unwrap();
    }
    assert_eq!(registry.open_popups("s1"), MAX_OPEN_POPUPS);
    let refused = registry.expect_popup_tab(&mint_agent_label(), OPENER, "https://example.com/4");
    assert_eq!(refused.unwrap_err(), PopupRefusal::Cap);

    registry.begin_close(&first);
    assert!(
        registry
            .expect_popup_tab(&mint_agent_label(), OPENER, "https://example.com/5")
            .is_ok(),
        "a closing popup frees its slot"
    );
}

#[test]
fn only_a_live_agent_tab_opens_popups() {
    let mut registry = registry_with_opener();
    let user = "tab-2d9e4f30-7182-4c3d-9e4f-5a6b7c8d9e0f";
    live(&mut registry, user);
    for opener in [user, "agent-1c8d3e2f-6071-4b2c-8d3e-4f5a6b7c8d9e"] {
        let refused =
            registry.expect_popup_tab(&mint_agent_label(), opener, "https://example.com/");
        assert_eq!(refused.unwrap_err(), PopupRefusal::NoOpener, "{opener}");
    }
    registry.begin_session_teardown("s1");
    let refused = registry.expect_popup_tab(&mint_agent_label(), OPENER, "https://example.com/");
    assert_eq!(refused.unwrap_err(), PopupRefusal::SessionEnding);
}
