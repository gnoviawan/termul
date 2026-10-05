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
