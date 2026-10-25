//! A render's wait scales with the pixels it writes; other calls keep the
//! call timeout.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasHolder};

const BASE: Duration = Duration::from_secs(10);

fn export(params: Value) -> Value {
    json!({"command": "file.export", "params": params})
}

#[test]
fn raster_exports_and_page_renders_are_renders() {
    assert_eq!(
        render_call(
            "engine.execute",
            &export(json!({"ids": [7, 9], "scale": 3}))
        ),
        Some(RenderCall {
            targets: Targets::Ids(vec![7, 9]),
            size: OutputSize::Scale(3.0)
        })
    );
    assert_eq!(
        render_call(
            "engine.execute",
            &export(json!({"format": "WEBP", "size": "512w"}))
        ),
        Some(RenderCall {
            targets: Targets::SelectionOrPage,
            size: OutputSize::Width(512.0)
        })
    );
    assert_eq!(
        render_call("host.renderPng", &json!({"scale": 0.5})),
        Some(RenderCall {
            targets: Targets::Page,
            size: OutputSize::Scale(0.5)
        })
    );
    for size in ["@2x", "2X", "2"] {
        assert_eq!(
            render_call("engine.execute", &export(json!({"size": size}))).map(|call| call.size),
            Some(OutputSize::Scale(2.0)),
            "{size}"
        );
    }
    assert_eq!(
        render_call("engine.execute", &export(json!({"size": "300h"}))).map(|call| call.size),
        Some(OutputSize::Height(300.0))
    );
}

#[test]
fn vector_exports_and_other_calls_are_not_renders() {
    for format in ["svg", "pdf", "fig"] {
        assert_eq!(
            render_call(
                "engine.execute",
                &export(json!({"format": format, "scale": 64}))
            ),
            None,
            "{format}"
        );
    }
    assert_eq!(
        render_call(
            "engine.execute",
            &json!({"command": "node.create", "params": {}})
        ),
        None
    );
    assert_eq!(render_call("node.get", &json!({"id": 1})), None);
}

#[test]
fn output_pixels_follow_the_scale_or_the_requested_side() {
    assert_eq!(
        output_pixels(OutputSize::Scale(64.0), 100.0, 100.0),
        6400.0 * 6400.0
    );
    assert_eq!(
        output_pixels(OutputSize::Scale(65.0), 100.0, 100.0),
        6400.0 * 6400.0,
        "figcraft renders past its largest scale at that scale"
    );
    assert_eq!(
        output_pixels(OutputSize::Width(512.0), 1024.0, 256.0),
        512.0 * 128.0
    );
    assert_eq!(
        output_pixels(OutputSize::Height(512.0), 1024.0, 256.0),
        2048.0 * 512.0
    );
}

#[test]
fn small_renders_keep_the_call_timeout_and_large_ones_wait_longer_up_to_a_ceiling() {
    let icon = render_budget(
        BASE,
        Some(output_pixels(OutputSize::Scale(2.0), 24.0, 24.0)),
    );
    assert!(icon < BASE + Duration::from_millis(100), "{icon:?}");

    // #1427: a 1440x3858 frame at 3x timed out at the fixed 10 s, and the
    // shadowed 100x100 rectangle at 32x took about 9 s.
    let landing = render_budget(
        BASE,
        Some(output_pixels(OutputSize::Scale(3.0), 1440.0, 3858.0)),
    );
    assert!(landing >= Duration::from_secs(60), "{landing:?}");
    let shadow_32 = render_budget(
        BASE,
        Some(output_pixels(OutputSize::Scale(32.0), 100.0, 100.0)),
    );
    assert!(shadow_32 >= Duration::from_secs(25), "{shadow_32:?}");
    let shadow_64 = render_budget(
        BASE,
        Some(output_pixels(OutputSize::Scale(64.0), 100.0, 100.0)),
    );
    assert!(
        shadow_64 > shadow_32 && shadow_64 <= MAX_RENDER_BUDGET,
        "{shadow_64:?}"
    );

    let huge = render_budget(
        BASE,
        Some(output_pixels(OutputSize::Scale(64.0), 1440.0, 3858.0)),
    );
    assert_eq!(huge, MAX_RENDER_BUDGET);
    assert_eq!(render_budget(BASE, None), MAX_RENDER_BUDGET, "unknown size");
    let configured = Duration::from_secs(300);
    assert!(
        render_budget(configured, Some(1.0)) >= configured,
        "a render never waits less than an ordinary call"
    );
}

/// A mounted editor whose layers have `bounds` (id → x, y, w, h); every
/// lookup it answers is counted.
fn editor(bounds: &'static [(u64, f64, f64, f64, f64)]) -> (Arc<CanvasPersistence>, &'static str) {
    let mounts = Arc::new(CanvasPersistence::default());
    let seq = mounts.mount(
        "budget",
        PathBuf::from("b.figcraft"),
        Duration::from_secs(60),
    );
    let replies = Arc::downgrade(&mounts);
    let deliver = move |frame: CanvasCallFrame| {
        let Some(mounts) = replies.upgrade() else {
            return false;
        };
        let params: Value = serde_json::from_str(&frame.params).unwrap();
        let node = |&(id, x, y, width, height): &(u64, f64, f64, f64, f64)| json!({"id": id, "absoluteBounds": {"x": x, "y": y, "width": width, "height": height}});
        let result = match frame.method.as_str() {
            "node.get" => bounds
                .iter()
                .find(|layer| Some(layer.0) == params["id"].as_u64())
                .map(node)
                .unwrap_or(Value::Null),
            "document.inspect" if params["depth"] == 0 => json!({"selection": []}),
            "document.inspect" => json!({"currentPage": 1, "pages": [
                {"id": 1, "children": bounds.iter().map(node).collect::<Vec<_>>()}
            ]}),
            _ => return true,
        };
        tokio::spawn(async move {
            mounts.reply(
                "conn",
                frame.call_id,
                frame.mount_seq,
                Ok(result.to_string()),
            );
        });
        true
    };
    let holder = CanvasHolder::new(
        "conn",
        crate::canvas::persistence::test_renderer(),
        Arc::new(deliver),
    );
    assert!(mounts.attach("budget", seq, holder));
    (mounts, "budget")
}

#[tokio::test]
async fn a_render_waits_for_the_union_of_its_layers_bounds() {
    let (mounts, project) = editor(&[
        (1, 0.0, 0.0, 1000.0, 1000.0),
        (2, 1000.0, 0.0, 1000.0, 1000.0),
    ]);
    let two = call_budget(
        &mounts,
        project,
        "engine.execute",
        Some(&export(json!({"ids": [1, 2], "scale": 2}))),
        BASE,
    )
    .await;
    let expected = render_budget(BASE, Some(4000.0 * 2000.0));
    assert_eq!(two, expected);
    let page = call_budget(
        &mounts,
        project,
        "host.renderPng",
        Some(&json!({"scale": 2})),
        BASE,
    )
    .await;
    assert_eq!(page, expected, "no ids: the page's layers");
    let selection = call_budget(
        &mounts,
        project,
        "engine.execute",
        Some(&export(json!({"scale": 2}))),
        BASE,
    )
    .await;
    assert_eq!(selection, expected, "nothing selected: the page's layers");
}

#[tokio::test]
async fn a_render_of_layers_it_cannot_measure_gets_the_ceiling() {
    let (mounts, project) = editor(&[]);
    let unknown = call_budget(
        &mounts,
        project,
        "engine.execute",
        Some(&export(json!({"ids": [5], "scale": 1}))),
        BASE,
    )
    .await;
    assert_eq!(unknown, MAX_RENDER_BUDGET);
}

#[tokio::test]
async fn other_calls_keep_the_call_timeout() {
    let mounts = CanvasPersistence::default();
    let budget = call_budget(&mounts, "none", "node.get", Some(&json!({"id": 1})), BASE).await;
    assert_eq!(budget, BASE);
    let vector = call_budget(
        &mounts,
        "none",
        "engine.execute",
        Some(&export(json!({"format": "svg"}))),
        BASE,
    )
    .await;
    assert_eq!(vector, BASE);
}
