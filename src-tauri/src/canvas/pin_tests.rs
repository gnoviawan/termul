use super::pin::{parse_pin, pin, pinned_tag, PinError};

const SHA: &str = "a414970e3857f6613efd7f90bd4c8394e5d51b31c4cf1fa0352f87820695b9c4";

fn pin_text(tag: &str, url: &str, sha: &str) -> String {
    format!("tag={tag}\nurl={url}\nsha256={sha}\n")
}

#[test]
fn parses_all_three_fields() {
    let parsed = parse_pin(&pin_text("termul-0.1.0", "https://example.test/b.zip", SHA)).unwrap();
    assert_eq!(parsed.tag, "termul-0.1.0");
    assert_eq!(parsed.url, "https://example.test/b.zip");
    assert_eq!(parsed.sha256, SHA);
}

#[test]
fn tolerates_crlf_and_blank_lines() {
    let text = format!("tag=v1\r\n\r\nurl=https://x.test/b.zip\r\nsha256={SHA}\r\n");
    assert_eq!(parse_pin(&text).unwrap().tag, "v1");
}

#[test]
fn rejects_missing_unknown_and_duplicate_fields() {
    assert_eq!(
        parse_pin(&format!("tag=v1\nsha256={SHA}\n")),
        Err(PinError::MissingField("url"))
    );
    assert_eq!(
        parse_pin(&format!("tag=v1\nurl=u\nsha256={SHA}\nextra=1\n")),
        Err(PinError::UnknownField("extra".into()))
    );
    assert_eq!(
        parse_pin(&format!("tag=v1\ntag=v2\nurl=u\nsha256={SHA}\n")),
        Err(PinError::DuplicateField("tag"))
    );
    assert_eq!(
        parse_pin("tag=v1\nnot a field\n"),
        Err(PinError::MalformedLine("not a field".into()))
    );
}

#[test]
fn rejects_non_hex_or_short_checksum() {
    for bad in ["abc", &SHA.to_uppercase(), &format!("{}g", &SHA[1..])] {
        assert_eq!(
            parse_pin(&pin_text("v1", "https://x.test/b.zip", bad)),
            Err(PinError::InvalidSha256),
            "{bad}"
        );
    }
}

#[test]
fn embedded_pin_is_valid() {
    assert!(!pin().tag.is_empty());
    assert_eq!(pinned_tag(), pin().tag);
    assert!(pin().url.starts_with("https://"));
}
