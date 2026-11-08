use std::sync::Arc;

use serde_json::{json, Value};

use super::registry::{parse_registry, store_servers};
use super::{McpServerConfig, McpServerEntry};
use crate::acp::mcp_probe::McpNameValuePair;
use crate::web::mcp_registry::STORE_KEY;
use crate::web::store::{Precondition, StorePolicy, WebStore};
use crate::web::ws::ClientIdentity;

fn stdio(name: &str, command: &str) -> McpServerConfig {
    McpServerConfig {
        r#type: None,
        name: name.to_string(),
        command: Some(command.to_string()),
        args: vec![],
        env: vec![],
        url: None,
        headers: vec![],
    }
}

fn ids(entries: &[McpServerEntry]) -> Vec<(&str, &str)> {
    entries
        .iter()
        .map(|e| (e.server_id.as_str(), e.name.as_str()))
        .collect()
}

fn stored_list() -> Value {
    json!([
        { "id": "srv-1", "name": "Files", "command": "npx", "args": ["-y", "fs"],
          "env": [{ "name": "TOKEN", "value": "t-123" }], "enabled": true,
          "catalog": { "source": "mcp-registry" } },
        { "id": "srv-2", "name": "Off", "command": "npx", "enabled": false },
        { "id": "srv-3", "type": "http", "name": "Remote", "url": "https://mcp.example.com",
          "headers": [{ "name": "X-Key", "value": "k-1" }] },
        { "name": "no id", "command": "x" },
        { "id": "srv-4", "name": "bad env", "command": "x", "env": "nope" },
        { "id": " ", "name": "blank id", "command": "x" },
        { "id": "srv-1", "name": "Shadow", "command": "y" },
        7
    ])
}

#[test]
fn keeps_enabled_well_formed_entries_and_flattens_their_config() {
    let entries = parse_registry(&stored_list());
    assert_eq!(ids(&entries), vec![("srv-1", "Files"), ("srv-3", "Remote")]);
    let mut files = stdio("Files", "npx");
    files.args = vec!["-y".into(), "fs".into()];
    files.env = vec![McpNameValuePair {
        name: "TOKEN".into(),
        value: "t-123".into(),
    }];
    assert_eq!(entries[0].config, files);
    assert_eq!(entries[1].config.r#type.as_deref(), Some("http"));
    assert_eq!(
        entries[1].config.url.as_deref(),
        Some("https://mcp.example.com")
    );
}

#[test]
fn reads_the_renderer_envelope_and_nothing_from_other_shapes() {
    let envelope = json!({ "_version": 1, "data": stored_list() });
    assert_eq!(
        ids(&parse_registry(&envelope)),
        vec![("srv-1", "Files"), ("srv-3", "Remote")]
    );
    assert_eq!(parse_registry(&json!({ "data": "x" })), vec![]);
    assert_eq!(parse_registry(&json!("x")), vec![]);
}

fn write_list(store: &WebStore, value: Value) {
    let client = ClientIdentity {
        device_id: "desktop-device".into(),
        client_instance_id: "tab-1".into(),
    };
    let base = Precondition {
        base_revision: Some(u64::MAX),
        ..Precondition::default()
    };
    store.write(STORE_KEY, value, base, &client, 1).unwrap();
}

#[test]
fn every_project_reads_the_one_stored_list() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        Arc::new(WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap());
    let servers = store_servers(store.clone());
    assert_eq!(servers("p1"), vec![]);

    write_list(&store, json!({ "_version": 1, "data": stored_list() }));
    for project in ["p1", "any-project", ""] {
        assert_eq!(
            ids(&servers(project)),
            vec![("srv-1", "Files"), ("srv-3", "Remote")],
            "{project}"
        );
    }

    write_list(&store, json!({ "_version": 1, "data": "not a list" }));
    assert_eq!(servers("p1"), vec![]);
}
