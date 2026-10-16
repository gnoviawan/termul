use super::scope::*;

#[test]
fn the_three_scopes_classify_and_everything_else_is_refused() {
    assert_eq!(classify("device/dev-a/shell-layout", "dev-a"), Ok(KeyScope::Device));
    assert_eq!(classify("device/dev-a/chat-draft/p/s", "dev-a"), Ok(KeyScope::Device));
    assert_eq!(classify("shared/lww/settings/app", "dev-a"), Ok(KeyScope::SharedLww));
    assert_eq!(classify("shared/cas/ssh/profiles", "dev-a"), Ok(KeyScope::SharedCas));
    for key in [
        "shell-layout",
        "host/lastSeen",
        "legacy/x",
        "shared/x",
        "shared/lww/",
        "shared/cas",
        "device/",
        "device/dev-a",
        "device/dev-a/",
        "device//x",
        "Device/dev-a/x",
    ] {
        assert!(classify(key, "dev-a").is_err(), "{key} must be refused");
    }
}

#[test]
fn a_device_key_must_name_the_callers_own_device() {
    assert!(classify("device/dev-b/k", "dev-a").is_err());
    // The segment is compared whole: a prefix of the id is another device.
    assert!(classify("device/dev-a2/k", "dev-a").is_err());
    assert!(classify("device/dev-a/k", "dev-a2").is_err());
}

#[test]
fn a_device_id_containing_a_slash_has_no_namespace() {
    assert_eq!(device_prefix("dev-a").as_deref(), Some("device/dev-a/"));
    assert_eq!(device_prefix("a/b"), None);
    assert_eq!(device_prefix(""), None);
    assert!(classify("device/a/b/k", "a/b").is_err());
    assert!(classify("device/a/k", "a/b").is_err());
}

#[test]
fn partition_of_reads_the_owner_of_a_device_key() {
    assert_eq!(partition_of("device/dev-a/k/x"), Some("dev-a"));
    assert_eq!(partition_of("shared/lww/k"), None);
    assert_eq!(partition_of("device/dev-a/"), None);
}
