use super::*;

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
