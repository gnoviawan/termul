use super::*;

// Throwaway keys generated for these tests only (`ssh-keygen -t ed25519`).
const PLAIN_ED25519: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACC3tR7tUgER2W7QBeZednZQQHQ22BV8QI8lWbekuq57rQAAAIiGCssEhgrL
BAAAAAtzc2gtZWQyNTUxOQAAACC3tR7tUgER2W7QBeZednZQQHQ22BV8QI8lWbekuq57rQ
AAAEAJmKHOkozivWBaukUpflJmsFCN70R6V3nJN7iZOJ/fZre1Hu1SARHZbtAF5l52dlBA
dDbYFXxAjyVZt6S6rnutAAAAAXQBAgME
-----END OPENSSH PRIVATE KEY-----
";

const ENCRYPTED_ED25519: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDcy4FDMn
vWWRz5KaYz58taAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAILPfd1VHxZsMQz8j
EWRxAKKoWg/9QhmME0hhwd0iiz4tAAAAkLFx1n6BbdGVqyIYXZ7GrYqbT+VyjgtsHvFdNB
ViiTqsBbFlTe9iJdpfaxN6mIDRKNKzMR6AP42WIq2cS7J8Zs1LxJOcBHQKp6XO0KkXy/e3
bvMhfYWKvM5A4DeSz5YD8eYGiGpSWSW4H8htoYlZ0l21kP3VqqfXlHE1hX6m/q1/jozQrR
iv7NG96gIMiuyeng==
-----END OPENSSH PRIVATE KEY-----
";

#[test]
fn openssh_plain_key_is_ok_without_passphrase() {
    let (status, encrypted, key_type) = classify(PLAIN_ED25519);
    assert_eq!(status, KeyFileStatus::Ok);
    assert!(!encrypted);
    assert_eq!(key_type.as_deref(), Some("ssh-ed25519"));
}

#[test]
fn openssh_encrypted_key_needs_passphrase() {
    let (status, encrypted, key_type) = classify(ENCRYPTED_ED25519);
    assert_eq!(status, KeyFileStatus::Ok);
    assert!(encrypted);
    assert_eq!(key_type.as_deref(), Some("ssh-ed25519"));
}

#[test]
fn pem_keys_report_encryption_from_headers() {
    let plain = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    let encrypted = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    assert_eq!(
        classify(plain),
        (KeyFileStatus::Ok, false, Some("ssh-rsa".to_string()))
    );
    assert_eq!(
        classify(encrypted),
        (KeyFileStatus::Ok, true, Some("ssh-rsa".to_string()))
    );
    assert_eq!(
        classify("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMII\n"),
        (KeyFileStatus::Ok, true, None)
    );
}

#[test]
fn public_keys_are_rejected() {
    assert_eq!(
        classify("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host").0,
        KeyFileStatus::NotPrivateKey
    );
    assert_eq!(classify("").0, KeyFileStatus::NotPrivateKey);
}

#[test]
fn putty_keys_report_type_and_encryption() {
    assert_eq!(
        classify("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"),
        (KeyFileStatus::Ok, false, Some("ssh-ed25519".to_string()))
    );
    assert_eq!(
        classify("PuTTY-User-Key-File-3: ssh-rsa\nEncryption: aes256-cbc\n"),
        (KeyFileStatus::Ok, true, Some("ssh-rsa".to_string()))
    );
}

#[test]
fn truncated_openssh_blob_is_not_a_key() {
    let truncated = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n";
    assert_eq!(classify(truncated).0, KeyFileStatus::NotPrivateKey);
}

#[test]
fn inspect_reports_missing_and_present_files() {
    let dir = std::env::temp_dir().join(format!("termul-keys-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let key_path = dir.join("id_test");
    std::fs::write(&key_path, ENCRYPTED_ED25519).unwrap();

    let found = inspect(&key_path.to_string_lossy());
    assert_eq!(found.status, KeyFileStatus::Ok);
    assert!(found.encrypted);

    let missing = inspect(&dir.join("absent").to_string_lossy());
    assert_eq!(missing.status, KeyFileStatus::NotFound);

    let directory = inspect(&dir.to_string_lossy());
    assert_eq!(directory.status, KeyFileStatus::NotPrivateKey);

    std::fs::remove_dir_all(&dir).unwrap();
}
