//! The conformance ratchet: what counts as an unexpected result.

#[path = "browser_conformance/expected.rs"]
mod expected;

use expected::{judge, parse, Known, Observed, Verdict};

const CAPABILITIES: &[&str] = &["snapshot", "click"];

fn known_snapshot_timeout() -> Vec<Known> {
    parse(
        r#"{"knownFailing":[{"capability":"snapshot","code":"timeout","observed":"x"}]}"#,
        CAPABILITIES,
    )
    .unwrap()
}

fn observed<'a>(capability: &'a str, failure_code: Option<&'a str>) -> Observed<'a> {
    Observed {
        capability,
        failure_code,
    }
}

#[test]
fn a_pass_that_is_not_listed_is_fine() {
    assert_eq!(judge(&observed("click", None), &known_snapshot_timeout()), Verdict::Pass);
}

#[test]
fn a_listed_failure_with_the_listed_code_is_tolerated() {
    assert_eq!(
        judge(&observed("snapshot", Some("timeout")), &known_snapshot_timeout()),
        Verdict::KnownFailure
    );
}

#[test]
fn an_unlisted_failure_is_unexpected() {
    let verdict = judge(&observed("click", Some("internal")), &known_snapshot_timeout());
    assert_eq!(
        verdict,
        Verdict::Unexpected("click failed with internal and is not a known failure".into())
    );
}

#[test]
fn a_listed_capability_that_passes_must_be_removed() {
    let verdict = judge(&observed("snapshot", None), &known_snapshot_timeout());
    assert_eq!(
        verdict,
        Verdict::Unexpected(
            "snapshot passes but is listed as failing; remove it from the expected file".into()
        )
    );
}

#[test]
fn a_listed_failure_with_another_code_is_unexpected() {
    let verdict = judge(&observed("snapshot", Some("internal")), &known_snapshot_timeout());
    assert_eq!(
        verdict,
        Verdict::Unexpected("snapshot failed with internal, the expected file says timeout".into())
    );
}

#[test]
fn parse_rejects_unknown_capabilities_and_duplicates() {
    let unknown = r#"{"knownFailing":[{"capability":"nope","code":"timeout"}]}"#;
    assert_eq!(parse(unknown, CAPABILITIES).unwrap_err(), "unknown capability `nope`");
    let twice = r#"{"knownFailing":[{"capability":"click","code":"timeout"},{"capability":"click","code":"timeout"}]}"#;
    assert_eq!(parse(twice, CAPABILITIES).unwrap_err(), "duplicate entry for `click`");
}
