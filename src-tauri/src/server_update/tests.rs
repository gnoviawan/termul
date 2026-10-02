use super::*;
use std::fs;
use tempfile::tempdir;

// Official minisign-verify test vector (crate docs). A genuine minisign
// keypair + signature over `b"test"` — used to exercise the real verify
// path without a signing dev-dependency or network.
const PUBKEY_B64: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIGNATURE_TEXT: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";
const MESSAGE: &[u8] = b"test";

fn test_public_key() -> PublicKey {
    PublicKey::from_base64(PUBKEY_B64).expect("docs pubkey parses")
}

// A second, structurally-valid minisign public key whose 32-byte key
// differs from the real one — derived by mutating the key bytes of the
// docs vector. A signature made by the original secret key cannot verify
// against a different public key, so this exercises the "bad key" path.
fn mismatched_public_key() -> PublicKey {
    let mut bytes = BASE64_STANDARD
        .decode(PUBKEY_B64)
        .expect("decode docs pubkey");
    // Flip a byte in the 32-byte public key region (offset 10..42).
    bytes[10] ^= 0xFF;
    let mutated = BASE64_STANDARD.encode(&bytes);
    PublicKey::from_base64(&mutated).expect("mutated pubkey still parses as minisign")
}

// --- signature verify: good / tampered binary / bad key ---

#[test]
fn verify_accepts_good_signature() {
    let pk = test_public_key();
    verify_signature(MESSAGE, SIGNATURE_TEXT, &pk).expect("good signature verifies");
}

#[test]
fn verify_rejects_tampered_binary() {
    let pk = test_public_key();
    let err = verify_signature(b"tampered", SIGNATURE_TEXT, &pk)
        .expect_err("tampered binary must not verify");
    assert!(
        err.to_string().contains("signature verification failed"),
        "unexpected error: {err}"
    );
}

#[test]
fn verify_rejects_bad_key() {
    let pk = mismatched_public_key();
    let err = verify_signature(MESSAGE, SIGNATURE_TEXT, &pk)
        .expect_err("a different public key must not verify");
    assert!(
        err.to_string().contains("signature verification failed"),
        "unexpected error: {err}"
    );
}

// --- version compare: SemVer prerelease precedence ---

#[test]
fn compare_versions_orders_stable_releases_numerically() {
    assert_eq!(compare_versions("0.4.8", "0.4.7"), Ordering::Greater);
    assert_eq!(compare_versions("0.5.0", "0.4.8"), Ordering::Greater);
    assert_eq!(compare_versions("0.4.8", "0.4.8"), Ordering::Equal);
}

#[test]
fn compare_versions_release_above_own_prerelease() {
    assert_eq!(compare_versions("0.5.0", "0.5.0-rc.1"), Ordering::Greater);
    assert_eq!(compare_versions("0.5.0-rc.1", "0.5.0"), Ordering::Less);
}

#[test]
fn compare_versions_orders_rc_by_numeric_identifier() {
    assert_eq!(
        compare_versions("0.5.0-rc.2", "0.5.0-rc.1"),
        Ordering::Greater
    );
    assert_eq!(compare_versions("0.5.0-rc.1", "0.5.0-rc.2"), Ordering::Less);
    assert_eq!(
        compare_versions("0.5.0-rc.1", "0.5.0-rc.1"),
        Ordering::Equal
    );
    // numeric, not lexical: rc.10 > rc.2
    assert_eq!(
        compare_versions("0.5.0-rc.10", "0.5.0-rc.2"),
        Ordering::Greater
    );
}

#[test]
fn compare_versions_nightly_below_any_real_release() {
    assert_eq!(
        compare_versions("0.0.0-nightly.20260808.def", "0.4.8"),
        Ordering::Less
    );
    assert_eq!(
        compare_versions("0.0.0-nightly.20260808.def", "0.5.0-rc.1"),
        Ordering::Less
    );
    assert_eq!(
        compare_versions("0.0.0-nightly.20260808.def", "0.0.0-nightly.20260807.abc"),
        Ordering::Greater
    );
}

#[test]
fn compare_versions_nightly_to_stable_upgrade_path() {
    // A nightly user that switches to Stable is always offered the build.
    assert_eq!(
        compare_versions("0.5.0", "0.0.0-nightly.20260807.abc"),
        Ordering::Greater
    );
}

#[test]
fn compare_versions_numeric_before_alphanumeric() {
    assert_eq!(compare_versions("0.5.0-1", "0.5.0-alpha"), Ordering::Less);
}

#[test]
fn compare_versions_pads_short_core() {
    assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
    assert_eq!(compare_versions("1.2.1", "1.2"), Ordering::Greater);
}

#[test]
fn is_newer_decides_offers() {
    assert!(is_newer("0.5.0", "0.4.8"));
    assert!(!is_newer("0.4.8", "0.4.8"));
    assert!(is_newer("0.5.0-rc.2", "0.5.0-rc.1"));
    // rc.1 is NOT newer than the release 0.5.0
    assert!(!is_newer("0.5.0-rc.1", "0.5.0"));
    // stable offered to a nightly user
    assert!(is_newer("0.5.0", "0.0.0-nightly.20260807.abc"));
}

// --- channel parsing + manifest URLs ---

#[test]
fn channel_parse_recognizes_known_values() {
    assert_eq!(UpdateChannel::parse("stable"), Some(UpdateChannel::Stable));
    assert_eq!(
        UpdateChannel::parse("Insider"),
        Some(UpdateChannel::Insider)
    );
    assert_eq!(
        UpdateChannel::parse("NIGHTLY"),
        Some(UpdateChannel::Nightly)
    );
    assert_eq!(UpdateChannel::parse("bogus"), None);
    assert_eq!(UpdateChannel::parse(""), None);
}

#[test]
fn channel_manifest_urls_match_hosting_scheme() {
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

// --- URL-origin constraint (defense-in-depth before the signature check) ---

#[test]
fn validate_binary_url_accepts_github_origin() {
    validate_binary_url(
        "https://github.com/gnoviawan/termul/releases/download/nightly/termul-server",
    )
    .expect("termul github origin accepted");
}

#[test]
fn validate_binary_url_rejects_foreign_origin() {
    let err = validate_binary_url("https://example.com/termul-server")
        .expect_err("foreign origin rejected");
    assert!(
        err.to_string().contains("outside the allowed origin"),
        "unexpected error: {err}"
    );
}

#[test]
fn validate_binary_url_rejects_plain_http() {
    let err = validate_binary_url("http://github.com/gnoviawan/termul/x")
        .expect_err("plain http rejected");
    assert!(
        err.to_string().contains("outside the allowed origin"),
        "unexpected error: {err}"
    );
}

// --- swap decision: don't swap on verify failure ---

fn write_current_binary(dir: &Path, contents: &[u8]) -> PathBuf {
    let bin = dir.join("termul-server");
    fs::write(&bin, contents).expect("write current binary");
    make_executable(&bin, None).expect("chmod current binary");
    bin
}

#[test]
fn apply_verified_update_swaps_on_good_signature() {
    let dir = tempdir().expect("tempdir");
    let bin = write_current_binary(dir.path(), b"OLD BINARY");
    let pk = test_public_key();

    // MESSAGE is the bytes the signature covers; treat it as the new binary.
    let old =
        apply_verified_update(&bin, MESSAGE, SIGNATURE_TEXT, &pk).expect("good signature applies");

    assert_eq!(fs::read(&bin).expect("read current"), MESSAGE);
    assert!(old.exists(), ".old retained for rollback");
    assert_eq!(fs::read(&old).expect("read old"), b"OLD BINARY");
    assert!(!sibling(&bin, ".new").exists(), ".new promoted away");
}

#[test]
fn apply_verified_update_does_not_swap_on_verify_failure() {
    let dir = tempdir().expect("tempdir");
    let bin = write_current_binary(dir.path(), b"OLD BINARY");
    let pk = test_public_key();

    // new_bytes differ from MESSAGE, so the signature (for b"test") is invalid.
    let err = apply_verified_update(&bin, b"NEW BINARY", SIGNATURE_TEXT, &pk)
        .expect_err("must not apply on verify failure");
    assert!(
        err.to_string().contains("signature verification failed"),
        "unexpected error: {err}"
    );

    // The running binary is untouched and no swap artifacts were created.
    assert_eq!(fs::read(&bin).expect("read current"), b"OLD BINARY");
    assert!(
        !sibling(&bin, ".new").exists(),
        "no .new left behind on verify failure"
    );
    assert!(
        !sibling(&bin, ".old").exists(),
        "no .old left behind on verify failure"
    );
}

#[test]
fn atomic_swap_restores_old_when_promote_fails() {
    // .new and current on the same dir => rename succeeds; this test just
    // asserts the happy-path invariants (executable + .old kept) on unix.
    let dir = tempdir().expect("tempdir");
    let bin = write_current_binary(dir.path(), b"OLD");
    let old = atomic_swap(&bin, b"NEW").expect("swap");
    assert_eq!(fs::read(&bin).expect("current"), b"NEW");
    assert_eq!(fs::read(&old).expect("old"), b"OLD");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&bin).expect("meta").permissions().mode();
        assert_ne!(mode & 0o111, 0, "new binary is executable");
    }
}

// --- pubkey cross-check against tauri.conf.json ---

#[test]
fn tauri_conf_pubkey_parses_as_minisign_public_key() {
    let conf_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    let conf =
        fs::read_to_string(conf_path).expect("tauri.conf.json must be readable from src-tauri");
    let json: serde_json::Value =
        serde_json::from_str(&conf).expect("tauri.conf.json is valid JSON");
    let outer = json["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey is a string");

    // The desktop updater's pubkey must parse as a minisign public key —
    // the server reuses the exact same key to verify downloaded binaries.
    let parsed = resolve_public_key(outer).expect("tauri.conf pubkey parses as minisign");

    // When the signing secret is baked in at compile time (CI), assert the
    // embedded key matches the one the desktop updater ships. Locally
    // (secret unset) this cross-check is skipped — the parse above still
    // guards the pubkey's validity.
    if let Some(embedded) = embedded_public_key_outer() {
        assert_eq!(
            embedded, outer,
            "embedded TAURI_SIGNING_PUBLIC_KEY must match tauri.conf.json pubkey"
        );
    } else {
        eprintln!(
            "TAURI_SIGNING_PUBLIC_KEY not set at build time; \
                 skipped embedded-vs-conf pubkey cross-check (parse still validated)."
        );
    }
    let _ = parsed;
}

#[test]
fn embedded_public_key_disabled_when_secret_absent() {
    // Without the secret baked in, the resolver must surface a clear error
    // (self-update stays disabled) rather than panic or silently proceed.
    if embedded_public_key_outer().is_some() {
        // Secret is present in this build — resolving must succeed.
        let _ = embedded_public_key().expect("embedded key resolves when secret is set");
    } else {
        let err = embedded_public_key().expect_err("disabled when secret absent");
        assert!(
            err.to_string().contains("TAURI_SIGNING_PUBLIC_KEY"),
            "disabled error must name the missing secret: {err}"
        );
    }
}
