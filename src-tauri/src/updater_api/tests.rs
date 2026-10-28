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
    let current = v("0.5.0-nightly.20261027.100.aaaaaaa");
    let accepts =
        |remote: &str| accepts_channel_update(UpdateChannel::Nightly, &current, &v(remote));

    assert!(accepts("0.5.0-nightly.20261028.101.bbbbbbb"));
    assert!(accepts("0.6.0-nightly.20261101.140.ccccccc"));
    assert!(!accepts("0.5.0-nightly.20261027.100.aaaaaaa"), "same build");
    assert!(
        !accepts("0.5.0-nightly.20261020.90.ddddddd"),
        "older nightly"
    );
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
        &v("0.5.0-nightly.20261028.101.bbbbbbb")
    ));
}

#[test]
fn non_nightly_channels_never_accept_signed_channel_updates() {
    let current = v("0.4.52");
    let remote = v("0.5.0-nightly.20261028.101.bbbbbbb");
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

/// Nightly versions are `X.Y.Z-nightly.<YYYYMMDD>.<run_number>.<sha>`: the
/// workflow run number gives a strict, total order between same-day builds,
/// so the SHA never decides ordering.
fn nightly_accepts(current: &str, remote: &str) -> bool {
    accepts_channel_update(UpdateChannel::Nightly, &v(current), &v(remote))
}

#[test]
fn same_day_nightlies_order_by_run_number_not_sha() {
    // Later run, lexically smaller SHA: still newer.
    assert!(nightly_accepts(
        "0.5.0-nightly.20261027.120.f123abc",
        "0.5.0-nightly.20261027.121.a456def"
    ));
    // Earlier run, lexically larger SHA: still older.
    assert!(!nightly_accepts(
        "0.5.0-nightly.20261027.121.a456def",
        "0.5.0-nightly.20261027.120.f123abc"
    ));
}

#[test]
fn update_from_a_to_b_never_offers_a_again() {
    let a = "0.5.0-nightly.20261027.120.f123abc";
    let b = "0.5.0-nightly.20261027.121.a456def";
    assert!(nightly_accepts(a, b), "A -> B is offered");
    assert!(!nightly_accepts(b, a), "B -> A is never offered");
    assert!(!nightly_accepts(b, b), "B is not re-offered once installed");
}

#[test]
fn installed_build_is_never_offered_again() {
    for build in [
        "0.5.0-nightly.20261027.120.f123abc",
        "0.5.0-nightly.20261027.120.1234567",
        "0.5.0-nightly.20261027.f123abc",
    ] {
        assert!(!nightly_accepts(build, build), "{build}");
    }
}

#[test]
fn older_builds_are_never_offered() {
    let current = "0.5.0-nightly.20261027.120.f123abc";
    for older in [
        "0.5.0-nightly.20261027.119.fffffff",
        "0.5.0-nightly.20261026.130.fffffff",
        "0.4.9-nightly.20261101.200.fffffff",
    ] {
        assert!(!nightly_accepts(current, older), "{older}");
    }
}

#[test]
fn same_day_builds_without_a_run_number_are_not_ordered_by_sha() {
    // Legacy `nightly.<date>.<sha>` builds carry no order within a day.
    assert!(!nightly_accepts(
        "0.5.0-nightly.20261027.a456def",
        "0.5.0-nightly.20261027.f123abc"
    ));
    assert!(!nightly_accepts(
        "0.5.0-nightly.20261027.120.f123abc",
        "0.5.0-nightly.20261027.f999999"
    ));
    // A legacy install still moves to a run-numbered build on a later date.
    assert!(nightly_accepts(
        "0.5.0-nightly.20261027.f123abc",
        "0.5.0-nightly.20261028.130.a456def"
    ));
}

/// Stable never reads the Nightly manifest and Nightly never reads the
/// Stable one.
#[test]
fn stable_and_nightly_manifests_never_cross() {
    let nightly = signed_channel_endpoint(UpdateChannel::Nightly).expect("nightly endpoint");
    assert!(nightly.ends_with("/releases/download/nightly/latest-nightly.json"));
    assert_ne!(nightly, UpdateChannel::Stable.manifest_url());
    assert!(!nightly.contains("/latest/download/"));
    assert_eq!(signed_channel_endpoint(UpdateChannel::Stable), None);

    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
    let stable_endpoints = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("stable updater endpoints");
    assert!(!stable_endpoints.is_empty());
    for endpoint in stable_endpoints {
        let endpoint = endpoint.as_str().expect("endpoint string");
        assert!(!endpoint.contains("nightly"), "{endpoint}");
        assert_ne!(endpoint, nightly);
    }
}
