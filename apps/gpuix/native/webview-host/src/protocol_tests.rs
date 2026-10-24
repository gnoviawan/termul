use super::*;

#[test]
fn parses_create_with_bounds() {
    let cmd = parse_command(
        r#"{"op":"create","req":3,"id":"t1","url":"http://127.0.0.1/","bounds":{"x":1,"y":2,"width":300,"height":200}}"#,
    )
    .unwrap();
    assert_eq!(
        cmd,
        Command::Create {
            req: 3,
            id: "t1".into(),
            url: "http://127.0.0.1/".into(),
            bounds: Bounds { x: 1.0, y: 2.0, width: 300.0, height: 200.0 },
        }
    );
    assert_eq!(cmd.req(), Some(3));
}

#[test]
fn parses_blur_and_quit() {
    assert_eq!(parse_command(r#"{"op":"blur","req":9}"#).unwrap(), Command::Blur { req: 9 });
    assert_eq!(parse_command(r#"{"op":"quit"}"#).unwrap(), Command::Quit);
    assert_eq!(Command::Quit.req(), None);
}

#[test]
fn rejects_unknown_ops_and_missing_fields() {
    assert!(parse_command(r#"{"op":"explode","req":1}"#).is_err());
    assert!(parse_command(r#"{"op":"navigate","req":1,"id":"t1"}"#).is_err());
    assert!(parse_command("not json").is_err());
}

#[test]
fn encodes_events_as_tagged_camel_case() {
    assert_eq!(
        encode(&Event::Ack { req: 4, ok: true, error: None }),
        r#"{"ev":"ack","req":4,"ok":true}"#
    );
    assert_eq!(
        encode(&Event::Ack { req: 5, ok: false, error: Some("no such tab: t9".into()) }),
        r#"{"ev":"ack","req":5,"ok":false,"error":"no such tab: t9"}"#
    );
    assert_eq!(encode(&Event::Keyboard { owner: None }), r#"{"ev":"keyboard","owner":null}"#);
    assert_eq!(
        encode(&Event::Console { id: "t1".into(), level: "log".into(), text: "hi".into() }),
        r#"{"ev":"console","id":"t1","level":"log","text":"hi"}"#
    );
}

#[test]
fn parses_page_messages_and_drops_garbage() {
    assert_eq!(
        parse_page_message(r#"{"kind":"url","url":"http://x/#a"}"#),
        Some(PageMessage::Url { url: "http://x/#a".into() })
    );
    assert_eq!(
        parse_page_message(r#"{"kind":"console","level":"warn","text":"w"}"#),
        Some(PageMessage::Console { level: "warn".into(), text: "w".into() })
    );
    assert_eq!(parse_page_message(r#"{"kind":"other"}"#), None);
    assert_eq!(parse_page_message("[]"), None);
}
