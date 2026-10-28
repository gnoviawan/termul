use super::*;
use crate::server_update::UpdateChannel;

/// An unknown channel must fail WITHOUT any network call — the parse is
/// the gate, so a bogus value never reaches reqwest.
#[tokio::test]
async fn fetch_channel_manifest_rejects_unknown_channel_without_network() {
    let result = fetch_channel_manifest("bogus").await;
    let err = result.expect_err("bogus channel must error");
    assert!(
        err.contains("unknown update channel"),
        "unexpected error: {err}"
    );
}

/// Parity guard: the three accepted channels must map to the same URLs
/// `server_update::UpdateChannel::manifest_url()` returns. If someone
/// changes the Rust constant, this breaks — prompting a check that the
/// renderer `CHANNEL_MANIFEST_URLS` constant (the error-message source)
/// is updated in lockstep so the surfaced error keeps naming the right URL.
#[test]
fn channel_manifest_urls_match_server_update() {
    assert_eq!(
        UpdateChannel::Stable.manifest_url(),
        "https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json"
    );
    assert_eq!(
        UpdateChannel::Insider.manifest_url(),
        "https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json"
    );
    assert_eq!(
        UpdateChannel::Nightly.manifest_url(),
        "https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json"
    );
}

/// Only Nightly is served by the signed in-app channel check; Stable keeps the
/// build-time `plugins.updater.endpoints` and Insider stays manual.
#[test]
fn signed_channel_endpoint_is_nightly_only() {
    assert_eq!(
        signed_channel_endpoint(UpdateChannel::Nightly),
        Some(UpdateChannel::Nightly.manifest_url())
    );
    assert_eq!(signed_channel_endpoint(UpdateChannel::Stable), None);
    assert_eq!(signed_channel_endpoint(UpdateChannel::Insider), None);
}

#[test]
fn resolve_signed_channel_rejects_unsupported_channels_without_network() {
    assert_eq!(
        resolve_signed_channel("nightly"),
        Ok(UpdateChannel::Nightly)
    );
    let insider = resolve_signed_channel("insider").expect_err("insider is manual");
    assert!(
        insider.contains("does not support in-app updates"),
        "{insider}"
    );
    let stable = resolve_signed_channel("stable").expect_err("stable uses check()");
    assert!(
        stable.contains("does not support in-app updates"),
        "{stable}"
    );
    let bogus = resolve_signed_channel("bogus").expect_err("bogus channel");
    assert!(bogus.contains("unknown update channel"), "{bogus}");
}

fn v(s: &str) -> semver::Version {
    semver::Version::parse(s).expect("valid semver")
}

#[test]
fn nightly_channel_accepts_only_newer_nightly_builds() {
    let current = v("0.5.0-nightly.20261027.aaaaaaa");
    let accepts =
        |remote: &str| accepts_channel_update(UpdateChannel::Nightly, &current, &v(remote));

    assert!(accepts("0.5.0-nightly.20261028.bbbbbbb"));
    assert!(accepts("0.6.0-nightly.20261101.ccccccc"));
    assert!(!accepts("0.5.0-nightly.20261027.aaaaaaa"), "same build");
    assert!(!accepts("0.5.0-nightly.20261020.ddddddd"), "older nightly");
    assert!(!accepts("0.5.0"), "stable build in the nightly manifest");
    assert!(
        !accepts("0.6.0-rc.1"),
        "insider build in the nightly manifest"
    );
}

#[test]
fn stable_user_switching_to_nightly_gets_the_nightly() {
    assert!(accepts_channel_update(
        UpdateChannel::Nightly,
        &v("0.4.52"),
        &v("0.5.0-nightly.20261028.bbbbbbb")
    ));
}

#[test]
fn non_nightly_channels_never_accept_signed_channel_updates() {
    let current = v("0.4.52");
    let remote = v("0.5.0-nightly.20261028.bbbbbbb");
    assert!(!accepts_channel_update(
        UpdateChannel::Stable,
        &current,
        &remote
    ));
    assert!(!accepts_channel_update(
        UpdateChannel::Insider,
        &current,
        &remote
    ));
}

/// Same-day nightlies differ only in the short SHA, which has no order
/// (`f123abc` > `a456def` lexically even if `a456def` is newer). The nightly
/// manifest always points at the latest build, so a different same-day build
/// in it is the newer one.
#[test]
fn same_day_nightly_with_a_different_sha_is_accepted_regardless_of_sha_order() {
    let current = v("0.5.0-nightly.20261027.f123abc");
    assert!(accepts_channel_update(
        UpdateChannel::Nightly,
        &current,
        &v("0.5.0-nightly.20261027.a456def")
    ));
    assert!(!accepts_channel_update(
        UpdateChannel::Nightly,
        &current,
        &v("0.5.0-nightly.20261027.f123abc")
    ));
    assert!(
        !accepts_channel_update(
            UpdateChannel::Nightly,
            &current,
            &v("0.5.0-nightly.20261026.fffffff")
        ),
        "an earlier date stays older whatever the SHA"
    );
}
