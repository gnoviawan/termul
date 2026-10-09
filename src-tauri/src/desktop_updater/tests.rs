use super::*;

#[test]
fn check_during_install_does_not_replace_the_handle() {
    let mut slot = PendingSlot::default();
    assert!(matches!(slot.store_check(Some("v1")), SlotStore::Stored));

    let owned = match slot.begin_install() {
        SlotBegin::Ready(version) => version,
        other => panic!("expected the pending handle, got a non-ready begin: {other:?}"),
    };
    assert_eq!(owned, "v1");

    assert_eq!(
        slot.store_check(Some("v2")),
        SlotStore::InstallInProgress,
        "a check must not overwrite the handle an install already owns"
    );
    assert!(slot.update.is_none());

    slot.abort_install(owned);
    assert_eq!(slot.update.as_deref(), Some("v1"));
    assert!(!slot.installing);
}

#[test]
fn failed_install_does_not_restore_after_clear() {
    let mut slot = PendingSlot::default();
    slot.store_check(Some("insider"));
    let owned = match slot.begin_install() {
        SlotBegin::Ready(version) => version,
        SlotBegin::Empty | SlotBegin::InstallInProgress => panic!("expected ready"),
    };

    slot.clear();
    slot.abort_install(owned);
    assert!(slot.update.is_none());
    assert!(!slot.installing);
}

#[test]
fn failed_install_does_not_overwrite_a_newer_stored_update() {
    let mut slot = PendingSlot::default();
    slot.store_check(Some("v1"));
    let owned = match slot.begin_install() {
        SlotBegin::Ready(version) => version,
        SlotBegin::Empty | SlotBegin::InstallInProgress => panic!("expected ready"),
    };

    slot.installing = false;
    assert!(matches!(slot.store_check(Some("v2")), SlotStore::Stored));
    slot.abort_install(owned);
    assert_eq!(slot.update.as_deref(), Some("v2"));
}

#[test]
fn stable_accepts_only_a_newer_manifest() {
    assert!(channel_should_update(
        UpdateChannel::Stable,
        "0.4.20",
        "0.5.0"
    ));
    assert!(!channel_should_update(
        UpdateChannel::Stable,
        "0.4.20",
        "0.4.20"
    ));
    assert!(!channel_should_update(
        UpdateChannel::Stable,
        "0.4.20",
        "0.4.8"
    ));
    // A nightly manifest is older than a stable build, so Stable must not offer it.
    assert!(!channel_should_update(
        UpdateChannel::Stable,
        "0.4.20",
        "0.0.0-nightly.20261005.abc"
    ));
}

#[test]
fn insider_and_nightly_accept_a_different_version() {
    assert!(channel_should_update(
        UpdateChannel::Nightly,
        "0.4.20",
        "0.0.0-nightly.20261005.abc"
    ));
    assert!(channel_should_update(
        UpdateChannel::Insider,
        "0.5.0",
        "0.5.1-rc.1"
    ));
    assert!(channel_should_update(
        UpdateChannel::Insider,
        "0.5.0",
        "0.5.0-rc.2"
    ));
    assert!(!channel_should_update(
        UpdateChannel::Nightly,
        "0.0.0-nightly.20261005.abc",
        "0.0.0-nightly.20261005.abc"
    ));
    assert!(!channel_should_update(
        UpdateChannel::Insider,
        "0.5.0-rc.1",
        ""
    ));
}

#[test]
fn endpoints_follow_the_selected_channel() {
    assert_eq!(
        channel_manifest_endpoints(UpdateChannel::Stable),
        vec![
            "https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json",
            "https://github.com/gnoviawan/termul/releases/latest/download/latest.json",
        ]
    );
    assert_eq!(
        channel_manifest_endpoints(UpdateChannel::Insider),
        vec!["https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json",]
    );
    assert_eq!(
        channel_manifest_endpoints(UpdateChannel::Nightly),
        vec!["https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json",]
    );
}
