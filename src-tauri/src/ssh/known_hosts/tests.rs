use super::*;

const KEY_A: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILe1Hu1SARHZbtAF5l52dlBAdDbYFXxAjyVZt6S6rnut";
const KEY_B: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEEV5zXY/yck2oa1s9iGQzElRNex74g7Aff7/3Oty5Y5";
const KEY_ECDSA: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFfS6TAyXeSLkq3eYYdm88lAZEHoaXJz5o97Kq8q8hVx5OiCBLieTbta8hiS/C4BuhpC7KSKKsnenlQyIS4ym00=";

fn key(text: &str) -> PublicKey {
    PublicKey::from_openssh(text).expect("test key parses")
}

#[test]
fn host_entry_brackets_non_default_ports() {
    assert_eq!(host_entry("example.com", 22), "example.com");
    assert_eq!(host_entry("example.com", 2222), "[example.com]:2222");
    assert_eq!(host_entry("::1", 2222), "[::1]:2222");
}

#[test]
fn info_reports_type_and_sha256_fingerprint() {
    let info = info_for("example.com", 22, &key(KEY_A));
    assert_eq!(info.key_type, "ssh-ed25519");
    assert!(info.fingerprint.starts_with("SHA256:"));
    // 32-byte digest = 43 unpadded base64 characters, like ssh-keygen -lf.
    assert_eq!(info.fingerprint.len(), "SHA256:".len() + 43);
}

#[test]
fn verdict_matches_plain_entries_and_lists() {
    let contents = format!("other.com {KEY_B}\nexample.com,10.0.0.1 {KEY_A}\n");
    assert_eq!(
        verdict(&contents, "example.com", &key(KEY_A)),
        FileVerdict::Match
    );
    assert_eq!(
        verdict(&contents, "10.0.0.1", &key(KEY_A)),
        FileVerdict::Match
    );
    assert_eq!(
        verdict(&contents, "nowhere.com", &key(KEY_A)),
        FileVerdict::NotFound
    );
}

#[test]
fn verdict_flags_a_changed_key_of_the_same_type() {
    let contents = format!("example.com {KEY_B}\n");
    assert_eq!(
        verdict(&contents, "example.com", &key(KEY_A)),
        FileVerdict::Mismatch
    );
}

#[test]
fn verdict_ignores_keys_of_another_type() {
    // A recorded ECDSA key says nothing about the ed25519 key now presented.
    let contents = format!("example.com {KEY_ECDSA}\n");
    assert_eq!(
        verdict(&contents, "example.com", &key(KEY_A)),
        FileVerdict::NotFound
    );
}

#[test]
fn verdict_reads_hashed_names_and_ports() {
    let contents = format!(
        "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|nnUK16ANsXd3hL31YfAkGOluSjU= {KEY_A}\n\
         |1|AAECAwQFBgcICQoLDA0ODxAREhM=|Wgcx+Fm+LmaWwC7rQ80eIf2uHe0= {KEY_B}\n"
    );
    assert_eq!(
        verdict(&contents, "example.com", &key(KEY_A)),
        FileVerdict::Match
    );
    assert_eq!(
        verdict(&contents, "[example.com]:2222", &key(KEY_B)),
        FileVerdict::Match
    );
    assert_eq!(
        verdict(&contents, "[example.com]:2222", &key(KEY_A)),
        FileVerdict::Mismatch
    );
}

#[test]
fn verdict_handles_wildcards_negation_and_markers() {
    let contents = format!(
        "*.example.com,!bad.example.com {KEY_A}\n\
         @cert-authority *.example.com {KEY_B}\n\
         @revoked * {KEY_B}\n"
    );
    assert_eq!(
        verdict(&contents, "web.example.com", &key(KEY_A)),
        FileVerdict::Match
    );
    assert_eq!(
        verdict(&contents, "bad.example.com", &key(KEY_A)),
        FileVerdict::NotFound
    );
    // A revoked key is refused even with no other entry for the host.
    assert_eq!(
        verdict(&contents, "anything.org", &key(KEY_B)),
        FileVerdict::Mismatch
    );
}

#[test]
fn verdict_skips_unreadable_lines() {
    let contents = format!(
        "# comment\n\nexample.com sk-unknown-type AAAAnotbase64\nbroken-line\nexample.com {KEY_A}\n"
    );
    assert_eq!(
        verdict(&contents, "example.com", &key(KEY_A)),
        FileVerdict::Match
    );
}

#[test]
fn combine_prefers_any_match() {
    use FileVerdict::*;
    assert_eq!(combine(Match, NotFound), HostKeyStatus::Trusted);
    assert_eq!(combine(NotFound, Match), HostKeyStatus::Trusted);
    // Re-trusted with system ssh, or replaced in Termul: still trusted.
    assert_eq!(combine(Mismatch, Match), HostKeyStatus::Trusted);
    assert_eq!(combine(Match, Mismatch), HostKeyStatus::Trusted);
    assert_eq!(combine(Mismatch, NotFound), HostKeyStatus::Changed);
    assert_eq!(combine(NotFound, Mismatch), HostKeyStatus::Changed);
    assert_eq!(combine(NotFound, NotFound), HostKeyStatus::Unknown);
}

#[test]
fn without_entry_removes_only_exact_host_lines() {
    let contents = "\
example.com ssh-ed25519 AAAAold
[example.com]:2222 ssh-ed25519 AAAAport
other.example.com ssh-rsa AAAAother
example.com,10.0.0.1 ssh-rsa AAAAlist
";
    let kept = without_entry(contents, "example.com");
    assert_eq!(
        kept,
        "[example.com]:2222 ssh-ed25519 AAAAport\nother.example.com ssh-rsa AAAAother\n"
    );
    let kept_port = without_entry(contents, "[example.com]:2222");
    assert!(!kept_port.contains("AAAAport"));
    assert!(kept_port.contains("AAAAold"));
}

#[test]
fn glob_matches_like_openssh() {
    assert!(glob_match(b"*.example.com", b"a.example.com"));
    assert!(glob_match(b"host?", b"host1"));
    assert!(glob_match(b"EXAMPLE.com", b"example.COM"));
    assert!(!glob_match(b"*.example.com", b"example.com"));
    assert!(!glob_match(b"host?", b"host12"));
}
