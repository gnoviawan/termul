//! The whole gateway path: `Bridge::call` in the child → the parent's TCP
//! listener → session → project resolution → the canvas router → a fake
//! renderer → back.

use std::time::Duration;

use figcraft_mcp::Backend;
use serde_json::{json, Value};

use super::*;
use crate::acp::host_mcp::canvas::CanvasCallFrame;
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
    assert_eq!(error["code"], "CANVAS_HIDDEN");
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.starts_with("the canvas tab is hidden. ") && message.contains("Canvas tab"),
        "{message}"
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
    let frame = std::iter::from_fn(|| seen.recv_timeout(Duration::from_secs(5)).ok())
        .find(|frame| frame.method != "node.get")
        .expect("the render reached the editor");
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
    let frame = std::iter::from_fn(|| seen.recv_timeout(Duration::from_secs(5)).ok())
        .find(|frame| frame.method == "engine.execute")
        .expect("the export reached the editor");
    let sent: Value = serde_json::from_str(&frame.params).unwrap();
    assert_eq!(
        sent,
        json!({"command": "file.export", "params": {"ids": [18_446_744_073_709_551_615u64], "scale": 2.0, "format": "png"}})
    );
}

#[test]
fn a_link_planted_while_the_editor_exports_does_not_redirect_the_write() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let outside_dir = tempfile::tempdir().unwrap();
    let outside = outside_dir.path().to_path_buf();
    let planted = harness.cwd.join("out");
    let (link_target, link) = (outside.clone(), planted.clone());
    let _seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, move |frame| {
        if frame.method != "engine.execute" {
            return Some(Ok("{}".to_string()));
        }
        link_dir(&link_target, &link).ok()?;
        Some(Ok(json!({"format": "svg", "data": "PHN2Zy8+"}).to_string()))
    });
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");
    let result = figcraft_mcp::call_tool(&mut bridge, "export", &json!({"path": "out/x.svg"}));
    if !planted.exists() {
        eprintln!("skipped: this machine cannot create a directory link");
        return;
    }
    assert_eq!(tool_error(&result)["code"], "UNSUPPORTED_IN_KIOSK");
    assert!(
        !outside.join("x.svg").exists(),
        "nothing was written outside the project"
    );
}

/// A directory link: a symlink, or on Windows without the symlink privilege a
/// junction, which needs none.
fn link_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    }
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

#[test]
fn an_oversize_request_is_an_engine_error_naming_the_limit_not_a_closed_canvas() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = mount_renderer(&harness.router(), "conn-a", "proj-1", 1, |_| {
        Some(Ok("{}".to_string()))
    });
    let limit = usize::try_from(crate::acp::host_mcp::MAX_REQUEST_FRAME_BYTES).unwrap();
    let mut bridge = Bridge::new(configs[0].clone());

    let error = error_of(bridge.call(
        "engine.execute",
        json!({ "command": "x", "params": { "text": "a".repeat(limit) } }),
    ));
    assert_eq!(error["code"], "ENGINE_ERROR", "{error}");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains(&limit.to_string()), "{message}");
    assert!(seen.recv_timeout(Duration::from_millis(200)).is_err());

    bridge
        .call(
            "engine.execute",
            json!({ "params": { "text": "a".repeat(limit / 2) } }),
        )
        .expect("a request under the limit reaches the editor");
}

/// An editor whose layer 1 is 100x100: an export at `scale: 3` is answered
/// only by the test (it outlasts its wait), any other export at once with
/// `quick`.
fn slow_large_exports(
    harness: &Harness,
    quick: &'static [u8],
) -> std::sync::mpsc::Receiver<CanvasCallFrame> {
    let router = harness.router();
    router.set_call_timeout(Duration::from_millis(150));
    mount_renderer(&router, "conn-a", "proj-1", 1, move |frame| {
        let params: Value = serde_json::from_str(&frame.params).unwrap();
        match frame.method.as_str() {
            "node.get" => Some(Ok(json!({
                "id": 1,
                "absoluteBounds": {"x": 0, "y": 0, "width": 100, "height": 100}
            })
            .to_string())),
            "engine.execute" if params["params"]["scale"] == 3.0 => None,
            "engine.execute" => Some(Ok(export_reply(quick))),
            _ => None,
        }
    })
}

fn export_reply(bytes: &[u8]) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({"format": "png", "data": data}).to_string()
}

fn slow_export(seen: &std::sync::mpsc::Receiver<CanvasCallFrame>) -> CanvasCallFrame {
    std::iter::from_fn(|| seen.recv_timeout(Duration::from_secs(5)).ok())
        .find(|frame| frame.method == "engine.execute")
        .expect("the export reached the editor")
}

/// The file once it exists, waiting up to five seconds for it.
fn written(path: &std::path::Path) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if let Ok(bytes) = std::fs::read(path) {
            return Some(bytes);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn an_export_that_outlasts_its_wait_is_still_written_when_it_finishes() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = slow_large_exports(&harness, b"quick");
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");

    let result = figcraft_mcp::call_tool(
        &mut bridge,
        "export",
        &json!({"ids": [1], "scale": 3, "path": "out/big.png"}),
    );

    let error = tool_error(&result);
    assert_eq!(error["code"], "CANVAS_TIMEOUT");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("writes it to `out/big.png`"), "{message}");
    assert!(message.contains("smaller `scale`"), "{message}");
    assert!(!message.contains("retry once"), "{message}");
    let target = harness.cwd.join("out/big.png");
    assert!(
        !target.exists(),
        "nothing is written before the editor finishes"
    );

    let frame = slow_export(&seen);
    assert!(harness.router().reply(
        "conn-a",
        frame.call_id,
        frame.mount_seq,
        Ok(export_reply(b"finished late"))
    ));

    assert_eq!(written(&target).as_deref(), Some(&b"finished late"[..]));
}

#[test]
fn a_late_export_never_replaces_a_newer_export_to_the_same_path() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let seen = slow_large_exports(&harness, b"newer and smaller");
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");
    let large = json!({"ids": [1], "scale": 3, "path": "out/hero.png"});
    let result = figcraft_mcp::call_tool(&mut bridge, "export", &large);
    assert_eq!(tool_error(&result)["code"], "CANVAS_TIMEOUT");
    let late = slow_export(&seen);

    let smaller = json!({"ids": [1], "scale": 1, "path": "out/hero.png"});
    let result = figcraft_mcp::call_tool(&mut bridge, "export", &smaller);
    assert_eq!(tool_json(&result)["path"], "out/hero.png");
    harness.router().reply(
        "conn-a",
        late.call_id,
        late.mount_seq,
        Ok(export_reply(b"older and larger")),
    );
    std::thread::sleep(Duration::from_millis(500));

    assert_eq!(
        std::fs::read(harness.cwd.join("out/hero.png")).unwrap(),
        b"newer and smaller"
    );
}

#[test]
fn a_timed_out_export_without_a_path_advises_a_smaller_size_not_a_retry() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let _seen = slow_large_exports(&harness, b"quick");
    let mut bridge = Bridge::new(configs[0].clone()).with_tool("export");

    let result = figcraft_mcp::call_tool(&mut bridge, "export", &json!({"ids": [1], "scale": 3}));

    let error = tool_error(&result);
    assert_eq!(error["code"], "CANVAS_TIMEOUT");
    let message = error["message"].as_str().unwrap();
    assert!(message.contains("smaller `scale` or `size`"), "{message}");
    assert!(!message.contains("retry once"), "{message}");
}
