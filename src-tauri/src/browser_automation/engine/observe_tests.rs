use super::*;

#[test]
fn urls_keep_origin_and_path_only() {
    for (raw, want) in [
        ("https://user:pw@example.com:8443/a/b?token=s3cret#frag", "https://example.com:8443/a/b"),
        ("http://127.0.0.1:5191/api/items?page=2", "http://127.0.0.1:5191/api/items"),
        ("wss://example.com/socket?auth=x", "wss://example.com/socket"),
        ("data:text/plain;base64,c2VjcmV0", "data:"),
        ("blob:https://example.com/7f1c", "blob:"),
        ("not a url", ""),
    ] {
        assert_eq!(strip_url(raw), want, "{raw}");
    }
}

#[test]
fn console_text_is_capped_on_a_char_boundary() {
    let long = "é".repeat(TEXT_MAX);
    let entry = ConsoleEntry::new(ConsoleLevel::Warn, &long, Some("https://example.com/app.js?v=1"));
    assert_eq!(entry.text.len(), TEXT_MAX);
    assert_eq!(entry.source.as_deref(), Some("https://example.com/app.js"));
    assert_eq!(ConsoleEntry::new(ConsoleLevel::Log, "x", Some("")).source, None);
}

#[test]
fn levels_map_console_methods_and_engine_levels() {
    for (name, want) in [
        ("log", ConsoleLevel::Log),
        ("debug", ConsoleLevel::Debug),
        ("verbose", ConsoleLevel::Debug),
        ("info", ConsoleLevel::Info),
        ("warning", ConsoleLevel::Warn),
        ("warn", ConsoleLevel::Warn),
        ("error", ConsoleLevel::Error),
        ("assert", ConsoleLevel::Error),
        ("table", ConsoleLevel::Log),
    ] {
        assert_eq!(ConsoleLevel::parse(name), want, "{name}");
    }
}

#[test]
fn entries_serialize_without_absent_fields() {
    let entry = NetworkEntry {
        method: "GET".into(),
        url: "https://h/".into(),
        status: None,
        resource: None,
        duration_ms: None,
        failed: false,
    };
    assert_eq!(serde_json::to_value(&entry).unwrap(), serde_json::json!({ "method": "GET", "url": "https://h/" }));
}

#[test]
fn shim_batches_parse_leniently() {
    let pulled = serde_json::json!({
        "batches": [
            r#"[{"level":"warn","text":"low disk","source":"http://h/app.js?v=2"},{"level":"bogus","text":"plain"}]"#,
            "not json",
            42,
            r#"[{"level":"error"},{"text":"no level"}]"#
        ]
    });
    assert_eq!(
        parse_console_batches(&pulled),
        vec![
            ConsoleEntry::new(ConsoleLevel::Warn, "low disk", Some("http://h/app.js")),
            ConsoleEntry::new(ConsoleLevel::Log, "plain", None),
            ConsoleEntry::new(ConsoleLevel::Log, "no level", None),
        ]
    );
    assert!(parse_console_batches(&serde_json::json!({ "error": "x" })).is_empty());
}
