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

#[test]
fn canvas_commands_and_messages_carry_json_text_unparsed() {
    let cmd = parse_command(
        r#"{"op":"createCanvas","req":7,"id":"c1","url":"http://127.0.0.1:1/canvas/a/b/?ms=1","bounds":{"x":0,"y":0,"width":10,"height":10}}"#,
    )
    .unwrap();
    assert_eq!(cmd.req(), Some(7));
    let data = r#"{"id":1,"method":"node.get","params":"{\"id\":18446744073709551615}","mountSeq":1}"#;
    let post = parse_command(&format!(r#"{{"op":"post","req":8,"id":"c1","data":{}}}"#, serde_json::to_string(data).unwrap())).unwrap();
    assert_eq!(post, Command::Post { req: 8, id: "c1".into(), data: data.into() });
    assert_eq!(
        parse_page_message(r#"{"kind":"canvasMessage","data":"{\"method\":\"event.ready\"}"}"#),
        Some(PageMessage::CanvasMessage { data: r#"{"method":"event.ready"}"#.into() })
    );
    assert_eq!(
        encode(&Event::CanvasMessage { id: "c1".into(), data: r#"{"id":1}"#.into() }),
        r#"{"ev":"canvasMessage","id":"c1","data":"{\"id\":1}"}"#
    );
}

#[test]
fn parses_render_mermaid_and_encodes_its_answer() {
    let cmd = parse_command(r#"{"op":"renderMermaid","req":5,"id":"m1","source":"flowchart LR\n A --> B"}"#).unwrap();
    assert_eq!(cmd, Command::RenderMermaid { req: 5, id: "m1".into(), source: "flowchart LR\n A --> B".into(), scale: None });
    assert_eq!(cmd.req(), Some(5));
    assert_eq!(
        parse_command(r#"{"op":"renderMermaid","req":6,"id":"m2","source":"flowchart LR","scale":5}"#).unwrap(),
        Command::RenderMermaid { req: 6, id: "m2".into(), source: "flowchart LR".into(), scale: Some(5.0) }
    );
    assert_eq!(
        parse_page_message(r#"{"kind":"mermaid","id":"m1","ok":false,"error":"Parse error"}"#),
        Some(PageMessage::Mermaid {
            id: "m1".into(),
            ok: false,
            png: None,
            svg: None,
            width: None,
            height: None,
            error: Some("Parse error".into()),
        })
    );
    assert_eq!(parse_page_message(r#"{"kind":"mermaidReady"}"#), Some(PageMessage::MermaidReady));
    assert_eq!(
        encode(&Event::Mermaid {
            id: "m1".into(),
            ok: true,
            png: Some("data:image/png;base64,AA".into()),
            svg: Some("<svg/>".into()),
            width: Some(10.5),
            height: Some(4.0),
            error: None,
        }),
        r#"{"ev":"mermaid","id":"m1","ok":true,"png":"data:image/png;base64,AA","svg":"<svg/>","width":10.5,"height":4.0}"#
    );
}
