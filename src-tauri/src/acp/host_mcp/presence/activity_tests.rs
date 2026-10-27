//! `derive_activity` over the control frames each figcraft tool really sends
//! (figcraft-mcp `tools.rs`), one table row per frame.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::activity::{derive_activity, Activity, Bounds, Look, Targets, MAX_FLASH_IDS};

fn exec(command: &str, params: Value) -> Value {
    json!({ "command": command, "params": params })
}

fn write(targets: Targets) -> Option<Activity> {
    Some(Activity {
        kind: Look::Write,
        targets,
    })
}

fn read(targets: Targets) -> Option<Activity> {
    Some(Activity {
        kind: Look::Read,
        targets,
    })
}

fn ids(ids: &[u64]) -> Targets {
    Targets::Nodes {
        ids: ids.to_vec(),
        last: None,
    }
}

const BOUNDS: Bounds = Bounds {
    x: 10.0,
    y: 20.0,
    width: 100.0,
    height: 50.0,
};

fn node(id: u64) -> Value {
    json!({
        "id": id,
        "type": "RECTANGLE",
        "absoluteBounds": { "x": 10, "y": 20, "width": 100, "height": 50 },
    })
}

struct Row {
    tool: &'static str,
    method: &'static str,
    params: Value,
    result: String,
    expect: Option<Activity>,
}

fn row(
    tool: &'static str,
    method: &'static str,
    params: Value,
    result: Value,
    expect: Option<Activity>,
) -> Row {
    Row {
        tool,
        method,
        params,
        result: result.to_string(),
        expect,
    }
}

const EXECUTE: &str = "engine.execute";

fn table() -> Vec<Row> {
    let document = json!({
        "currentPage": 1,
        "selection": [],
        "pages": [
            { "id": 99, "children": [node(98)] },
            { "id": 1, "children": [node(2), node(3)] },
        ],
    });
    vec![
        row(
            "list_commands",
            "engine.commands",
            json!({}),
            json!([]),
            None,
        ),
        row(
            "run_command",
            EXECUTE,
            exec("align.left", json!({ "ids": [1, 2] })),
            json!({}),
            write(ids(&[1, 2])),
        ),
        row(
            "run_command",
            EXECUTE,
            exec("object.duplicate", json!({})),
            json!({ "ids": [7, 8] }),
            write(ids(&[7, 8])),
        ),
        row(
            "run_command",
            EXECUTE,
            exec("fill.add", json!({})),
            json!({}),
            write(Targets::Selection),
        ),
        row(
            "run_command",
            EXECUTE,
            exec("edit.delete", json!({ "ids": [5] })),
            json!({ "deleted": [5] }),
            write(Targets::InPlace),
        ),
        row(
            "run_command",
            EXECUTE,
            exec("select.all", json!({})),
            json!({}),
            read(Targets::Selection),
        ),
        row(
            "run_command",
            EXECUTE,
            exec("view.zoomIn", json!({})),
            json!({}),
            None,
        ),
        row(
            "run_command",
            EXECUTE,
            exec("page.add", json!({})),
            json!({ "id": 40 }),
            None,
        ),
        row(
            "batch",
            EXECUTE,
            exec(
                "command.batch",
                json!({ "label": "Card", "commands": [
                    { "command": "node.create", "params": { "type": "frame" } },
                    { "command": "node.set", "params": { "ids": [{ "$step": 0, "field": "id" }], "props": {} } },
                    { "command": "node.set", "params": { "ids": [4], "props": {} } },
                ] }),
            ),
            json!([{ "id": 7 }, { "ok": true }, { "ok": true }]),
            write(ids(&[4, 7])),
        ),
        row(
            "batch",
            EXECUTE,
            exec(
                "command.batch",
                json!({ "label": "Card", "commands": [
                    { "command": "node.create", "as": "card", "params": { "type": "frame" } },
                    { "command": "node.create", "params": { "type": "text", "parent": { "$name": "card" } } },
                ] }),
            ),
            json!({ "results": [{ "id": 7 }, { "id": 8 }], "names": { "card": 7 } }),
            write(ids(&[7, 8])),
        ),
        row(
            "batch",
            EXECUTE,
            exec(
                "command.batch",
                json!({ "label": "Batch", "commands": [{ "command": "fill.add", "params": {} }] }),
            ),
            json!([{}]),
            write(Targets::Selection),
        ),
        row(
            "create_node",
            EXECUTE,
            exec("node.create", json!({ "type": "rectangle" })),
            json!({ "id": u64::MAX }),
            write(ids(&[u64::MAX])),
        ),
        row(
            "create_node",
            "node.get",
            json!({ "id": u64::MAX, "depth": 0 }),
            node(u64::MAX),
            None,
        ),
        row(
            "set_properties",
            EXECUTE,
            exec(
                "node.set",
                json!({ "ids": [3], "props": { "opacity": 0.5 } }),
            ),
            json!({}),
            write(ids(&[3])),
        ),
        row(
            "set_properties",
            EXECUTE,
            exec("node.set", json!({ "props": { "opacity": 0.5 } })),
            json!({}),
            write(Targets::Selection),
        ),
        row(
            "set_properties",
            "document.inspect",
            json!({ "depth": 0 }),
            json!({ "selection": [3] }),
            None,
        ),
        row(
            "set_properties",
            "node.get",
            json!({ "id": 3, "depth": 0 }),
            node(3),
            None,
        ),
        row(
            "inspect_document",
            "document.inspect",
            json!({ "depth": 4, "allPages": false }),
            document,
            read(Targets::Nodes {
                ids: vec![2, 3],
                last: Some(BOUNDS),
            }),
        ),
        row(
            "inspect_document",
            "document.inspect",
            json!({ "depth": 0, "allPages": false }),
            json!({ "currentPage": 1, "pages": [{ "id": 1 }] }),
            read(Targets::Page),
        ),
        row(
            "get_node",
            "node.get",
            json!({ "id": 9, "depth": 1 }),
            node(9),
            read(Targets::Nodes {
                ids: vec![9],
                last: Some(BOUNDS),
            }),
        ),
        row(
            "select",
            EXECUTE,
            exec("select.set", json!({ "ids": [4] })),
            json!({}),
            read(ids(&[4])),
        ),
        row(
            "select",
            EXECUTE,
            exec("select.none", json!({})),
            json!({}),
            None,
        ),
        row(
            "select",
            "document.inspect",
            json!({ "depth": 0 }),
            json!({ "selection": [4] }),
            None,
        ),
        row(
            "export",
            EXECUTE,
            exec("file.export", json!({ "ids": [2], "format": "png" })),
            json!({ "format": "png", "data": "iVBO" }),
            read(ids(&[2])),
        ),
        row(
            "export",
            EXECUTE,
            exec("file.export", json!({ "format": "svg" })),
            json!({ "format": "svg", "data": "PHN2" }),
            read(Targets::Selection),
        ),
        row(
            "screenshot",
            "host.renderPng",
            json!({ "scale": 1.0, "ids": [1] }),
            json!("iVBO"),
            read(ids(&[1])),
        ),
        row(
            "screenshot",
            "host.renderPng",
            json!({ "scale": 1.0 }),
            json!("iVBO"),
            read(Targets::Page),
        ),
        row(
            "screenshot",
            "document.inspect",
            json!({ "depth": 1 }),
            json!({}),
            None,
        ),
        row(
            "screenshot",
            "node.get",
            json!({ "id": 1, "depth": 0 }),
            node(1),
            None,
        ),
        row(
            "open_file",
            EXECUTE,
            exec("file.open", json!({ "path": "a.fig" })),
            json!({}),
            None,
        ),
        row(
            "save_file",
            "host.save",
            json!({}),
            json!({ "path": "d.figcraft" }),
            None,
        ),
        row(
            "undo",
            EXECUTE,
            exec("edit.undo", json!({})),
            json!({ "undone": "Move" }),
            write(Targets::Selection),
        ),
        row(
            "redo",
            EXECUTE,
            exec("edit.redo", json!({})),
            json!({ "redone": "Move" }),
            write(Targets::Selection),
        ),
        row(
            "pointer",
            "ui.pointer",
            json!({ "kind": "click", "x": 1, "y": 2 }),
            json!({}),
            None,
        ),
        row(
            "pointer",
            EXECUTE,
            exec("tool.set", json!({ "tool": "rectangle" })),
            json!({}),
            None,
        ),
        row("key", "ui.key", json!({ "key": "Escape" }), json!({}), None),
        row(
            "type_text",
            EXECUTE,
            exec("text.edit.begin", json!({ "id": 6 })),
            json!({}),
            write(ids(&[6])),
        ),
        row(
            "type_text",
            "ui.type",
            json!({ "text": "Hi" }),
            json!({}),
            None,
        ),
        row(
            "type_text",
            EXECUTE,
            exec("text.edit.end", json!({})),
            json!({}),
            None,
        ),
        row("inspect_ui", "ui.inspect", json!({}), json!({}), None),
    ]
}

#[test]
fn every_frame_of_every_figcraft_tool_derives_its_activity() {
    for row in table() {
        assert_eq!(
            derive_activity(row.tool, row.method, &row.params, &row.result),
            row.expect,
            "{} {} {}",
            row.tool,
            row.method,
            row.params
        );
    }
}

#[test]
fn the_table_covers_every_tool_figcraft_lists() {
    let listed: BTreeSet<String> = figcraft_mcp::tool_definitions()
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(str::to_string))
        .collect();
    let covered: BTreeSet<String> = table().iter().map(|row| row.tool.to_string()).collect();
    assert_eq!(covered, listed);
}

#[test]
fn a_call_from_no_tool_or_an_unparsable_result_shows_nothing() {
    let params = exec("node.create", json!({}));
    assert_eq!(derive_activity("-", EXECUTE, &params, "{}"), None);
    assert_eq!(
        derive_activity("create_node", EXECUTE, &params, "not json"),
        None
    );
}

#[test]
fn touched_ids_are_deduplicated_and_capped_to_the_last_ones() {
    let many: Vec<u64> = (1..=100).chain([50, 100]).collect();
    let params = exec("align.left", json!({ "ids": many }));
    let Some(Activity {
        targets: Targets::Nodes { ids, .. },
        ..
    }) = derive_activity("run_command", EXECUTE, &params, "{}")
    else {
        panic!("nodes expected");
    };
    assert_eq!(ids.len(), MAX_FLASH_IDS);
    assert_eq!(ids.last(), Some(&100));
    assert_eq!(ids.iter().filter(|id| **id == 50).count(), 1);
    assert!(!ids.contains(&1), "the oldest ids are dropped");
}

#[test]
fn a_result_wrapped_with_its_layout_issues_still_names_the_layers() {
    let checked = |command: &str, params: Value| json!({ "command": command, "params": params, "issues": true });
    let issues = json!([{ "id": 7, "name": "Title", "kind": "low_contrast", "message": "Raise the contrast." }]);
    let created = json!({ "result": { "id": 7 }, "issues": issues }).to_string();
    let create = checked("node.create", json!({ "type": "text" }));
    assert_eq!(
        derive_activity("create_node", EXECUTE, &create, &created),
        write(ids(&[7]))
    );
    let batch = checked(
        "command.batch",
        json!({ "commands": [{ "command": "node.create", "params": { "type": "frame" } }] }),
    );
    let built = json!({ "result": [{ "id": 8 }], "issues": issues }).to_string();
    assert_eq!(
        derive_activity("batch", EXECUTE, &batch, &built),
        write(ids(&[8]))
    );
    let duplicate = checked("object.duplicate", json!({}));
    let duplicated = json!({ "result": { "ids": [9] }, "issues": [] }).to_string();
    assert_eq!(
        derive_activity("run_command", EXECUTE, &duplicate, &duplicated),
        write(ids(&[9]))
    );
}
