use super::*;

#[test]
fn parse_opencode_major_accepts_plain_and_prefixed_v2() {
    assert_eq!(parse_opencode_major("2.0.25"), Some(2));
    assert_eq!(parse_opencode_major("v2.0.25"), Some(2));
    assert_eq!(parse_opencode_major("opencode 2.0.25\n"), Some(2));
    assert!(is_opencode_v2("2.0.25"));
    assert!(is_opencode_v2("v2.0.25"));
}

#[test]
fn parse_opencode_major_rejects_v1_and_empty() {
    assert_eq!(parse_opencode_major("1.18.30"), Some(1));
    assert!(!is_opencode_v2("1.18.30"));
    assert!(!is_opencode_v2("v1.18.35"));
    assert_eq!(parse_opencode_major(""), None);
    assert_eq!(parse_opencode_major("   \n"), None);
    assert_eq!(parse_opencode_major("opencode"), None);
    assert!(!is_opencode_v2(""));
}
