//! The whole gateway path: `Bridge::call` in the child → the parent's TCP
//! listener → session → project resolution → the canvas router → a fake
//! renderer → back.

use std::time::Duration;

use figcraft_mcp::Backend;
use serde_json::{json, Value};

use super::*;
use crate::acp::host_mcp::gateway_harness::{mount_renderer, Harness};

fn error_of(result: Result<Value, String>) -> Value {
    serde_json::from_str(&result.expect_err("the call must fail")).expect("Err(String) is JSON")
}

#[test]
fn a_bridge_call_round_trips_through_the_router_with_u64_ids_intact() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |frame| {
        assert!(
            frame.params.contains("18446744073709551615"),
            "params forwarded as text"
        );
        Some(Ok(
            r#"{"id":18446744073709551615,"type":"FRAME"}"#.to_string()
        ))
    });

    let mut bridge = Bridge::new(configs[0].clone());
    let result = bridge
        .call("node.get", json!({ "id": u64::MAX, "depth": 1 }))
        .unwrap();
    assert_eq!(result["id"].as_u64(), Some(u64::MAX));
    assert_eq!(result["type"], "FRAME");
    let frame = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(frame.project_id, "proj-1");
    assert_eq!(frame.method, "node.get");
}

#[test]
fn figcraft_tools_drive_the_bridge_as_their_backend() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let _seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |frame| {
        assert_eq!(frame.method, "node.get");
        Some(Ok(r#"{"id":4294967297,"name":"Card"}"#.to_string()))
    });
    let mut bridge = Bridge::new(configs[0].clone());
    let result =
        figcraft_mcp::call_tool(&mut bridge, "get_node", &json!({ "id": 4_294_967_297u64 }));
    assert!(!result.is_error, "{:?}", result.content);
    assert!(result.content[0]["text"].as_str().unwrap().contains("Card"));
}

#[test]
fn each_session_reaches_only_its_own_projects_canvas() {
    let (harness, configs) =
        Harness::new(&[("sess-1", Some("proj-1")), ("sess-2", Some("proj-2"))]);
    let router = harness.router();
    let _one = mount_renderer(&router, "conn-a", "proj-1", 1, |_| {
        Some(Ok(r#""one""#.into()))
    });
    let _two = mount_renderer(&router, "conn-b", "proj-2", 7, |_| {
        Some(Ok(r#""two""#.into()))
    });

    let mut first = Bridge::new(configs[0].clone());
    let mut second = Bridge::new(configs[1].clone());
    assert_eq!(
        first.call("document.inspect", json!({})).unwrap(),
        json!("one")
    );
    assert_eq!(
        second.call("document.inspect", json!({})).unwrap(),
        json!("two")
    );
}

#[test]
fn no_mount_is_a_typed_canvas_closed() {
    let (_harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let mut bridge = Bridge::new(configs[0].clone());
    let error = error_of(bridge.call("document.inspect", json!({})));
    assert_eq!(error["code"], "CANVAS_CLOSED");
    assert!(error["message"].is_string());
}

#[test]
fn a_session_without_a_project_is_canvas_closed() {
    let (_harness, configs) = Harness::new(&[("sess-1", None)]);
    let mut bridge = Bridge::new(configs[0].clone());
    assert_eq!(
        error_of(bridge.call("document.inspect", json!({})))["code"],
        "CANVAS_CLOSED"
    );
}

#[test]
fn a_silent_renderer_times_out_in_the_gateway() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let router = harness.router();
    router.set_call_timeout(Duration::from_millis(150));
    let _seen = mount_renderer(&router, "conn-a", "proj-1", 1, |_| None);
    let mut bridge = Bridge::new(configs[0].clone());
    assert_eq!(
        error_of(bridge.call("document.inspect", json!({})))["code"],
        "CANVAS_TIMEOUT"
    );
}

#[test]
fn a_remount_while_a_call_waits_is_canvas_closed() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let router = harness.router();
    let seen = mount_renderer(&router, "conn-a", "proj-1", 1, |_| None);
    let config = configs[0].clone();
    let call = std::thread::spawn(move || Bridge::new(config).call("document.inspect", json!({})));
    seen.recv_timeout(Duration::from_secs(5)).unwrap();
    let _next = mount_renderer(&router, "conn-a", "proj-1", 2, |_| None);
    assert_eq!(error_of(call.join().unwrap())["code"], "CANVAS_CLOSED");
}

#[test]
fn renderer_errors_reach_the_backend_as_typed_json() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let _seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Err(CanvasError::new(
            CanvasErrorCode::CanvasHidden,
            "the canvas tab is hidden",
        )))
    });
    let mut bridge = Bridge::new(configs[0].clone());
    let error = error_of(bridge.call("ui.screenshot", json!({})));
    assert_eq!(
        error,
        json!({"code": "CANVAS_HIDDEN", "message": "the canvas tab is hidden"})
    );
}

#[test]
fn render_png_asks_host_render_png_and_decodes_its_base64() {
    let png = b"\x89PNG\r\n\x1a\nrest";
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, move |_| {
        Some(Ok(Value::String(encoded.clone()).to_string()))
    });
    let mut bridge = Bridge::new(configs[0].clone());
    assert_eq!(bridge.render_png(&[7], 2.0).unwrap(), png.to_vec());
    let frame = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(frame.method, "host.renderPng");
    let params: Value = serde_json::from_str(&frame.params).unwrap();
    assert_eq!(params, json!({"scale": 2.0, "ids": [7]}));
}

fn tool_error(result: &figcraft_mcp::ToolResult) -> Value {
    assert!(result.is_error, "{:?}", result.content);
    serde_json::from_str(result.first_text()).expect("a canvas error is JSON")
}

fn tool_json(result: &figcraft_mcp::ToolResult) -> Value {
    assert!(!result.is_error, "{:?}", result.content);
    serde_json::from_str(result.first_text()).expect("a JSON tool result")
}

#[test]
fn save_file_runs_the_host_save_and_ignores_the_path() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Ok(r#"{"path":"design.figcraft"}"#.into()))
    });
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("save_file");
    let result = figcraft_mcp::call_tool(
        &mut bridge,
        "save_file",
        &json!({"path": "C:/Windows/evil.figcraft"}),
    );
    assert_eq!(tool_json(&result), json!({"path": "design.figcraft"}));
    let frame = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        (frame.method.as_str(), frame.params.as_str()),
        ("host.save", "{}")
    );
    assert!(!harness.cwd.join("evil.figcraft").exists());
}

#[test]
fn export_with_a_project_path_writes_the_inline_bytes_there() {
    let png = b"\x89PNG\r\n\x1a\nnot really";
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, move |_| {
        Some(Ok(json!({"format": "png", "data": encoded}).to_string()))
    });
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");
    let result = figcraft_mcp::call_tool(
        &mut bridge,
        "export",
        &json!({"ids": [18_446_744_073_709_551_615u64], "scale": 2, "path": "out/hero.png"}),
    );
    assert_eq!(
        tool_json(&result),
        json!({"path": "out/hero.png", "bytes": png.len(), "format": "png"})
    );
    assert_eq!(
        std::fs::read(harness.cwd.join("out/hero.png")).unwrap(),
        png
    );
    let frame = seen.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(frame.method, "engine.execute");
    let sent: Value = serde_json::from_str(&frame.params).unwrap();
    assert_eq!(
        sent,
        json!({"command": "file.export", "params": {"ids": [18_446_744_073_709_551_615u64], "scale": 2.0}})
    );
}

#[test]
fn export_outside_the_project_is_refused_before_the_editor_runs() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Ok(r#"{"format":"png","data":""}"#.into()))
    });
    let absolute = harness.cwd.join("abs.png");
    for path in [
        "../escape.png",
        "out/../../escape.png",
        absolute.to_str().unwrap(),
    ] {
        let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");
        let result = figcraft_mcp::call_tool(&mut bridge, "export", &json!({"path": path}));
        assert_eq!(
            tool_error(&result)["code"],
            "UNSUPPORTED_IN_KIOSK",
            "{path}"
        );
    }
    assert!(
        seen.recv_timeout(Duration::from_millis(200)).is_err(),
        "no call reached the editor"
    );
    assert!(!harness.cwd.parent().unwrap().join("escape.png").exists());
    assert!(!absolute.exists());
}

#[test]
fn export_without_a_path_returns_the_bytes_inline() {
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x03";
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let _seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, move |_| {
        Some(Ok(json!({"format": "png", "data": encoded}).to_string()))
    });
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");
    let result = figcraft_mcp::call_tool(&mut bridge, "export", &json!({}));
    assert!(!result.is_error, "{:?}", result.content);
    assert_eq!(result.content[0]["type"], "image");
    assert_eq!(result.content[0]["mimeType"], "image/png");
}

#[test]
fn open_file_and_file_commands_are_unsupported_in_kiosk() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Ok("{}".into()))
    });
    let calls = [
        ("open_file", json!({"path": "C:/a.figcraft"})),
        (
            "run_command",
            json!({"command": "file.import", "params": {"path": "a.svg"}}),
        ),
        (
            "batch",
            json!({"commands": [{"command": "node.create", "params": {}}, {"command": "file.save"}]}),
        ),
    ];
    for (tool, args) in calls {
        let mut bridge = Bridge::new(configs[0].clone()).with_tool(tool);
        let result = figcraft_mcp::call_tool(&mut bridge, tool, &args);
        assert_eq!(
            tool_error(&result)["code"],
            "UNSUPPORTED_IN_KIOSK",
            "{tool}"
        );
    }
    assert!(
        seen.recv_timeout(Duration::from_millis(200)).is_err(),
        "no call reached the editor"
    );
}

#[test]
fn canvas_tools_answer_canvas_closed_with_nothing_mounted() {
    let (_harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    for (tool, args) in [
        ("create_node", json!({"type": "frame"})),
        ("save_file", json!({})),
        ("inspect_document", json!({})),
        ("pointer", json!({"x": 1, "y": 1})),
    ] {
        let mut bridge = Bridge::new(configs[0].clone()).with_tool(tool);
        let result = figcraft_mcp::call_tool(&mut bridge, tool, &args);
        assert_eq!(tool_error(&result)["code"], "CANVAS_CLOSED", "{tool}");
    }
}

#[test]
fn ui_tools_pass_through_and_report_canvas_hidden() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Err(CanvasError::new(
            CanvasErrorCode::CanvasHidden,
            "the canvas tab is hidden",
        )))
    });
    for (tool, args, method) in [
        ("pointer", json!({"x": 10, "y": 20}), "ui.pointer"),
        ("key", json!({"key": "Escape"}), "ui.key"),
        ("type_text", json!({"text": "hi"}), "ui.type"),
        ("inspect_ui", json!({}), "ui.inspect"),
        ("screenshot", json!({"window": true}), "ui.screenshot"),
    ] {
        let mut bridge = Bridge::new(configs[0].clone()).with_tool(tool);
        let result = figcraft_mcp::call_tool(&mut bridge, tool, &args);
        assert_eq!(tool_error(&result)["code"], "CANVAS_HIDDEN", "{tool}");
        let frame = seen.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(frame.method, method, "{tool}");
    }
}
