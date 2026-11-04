use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::registry::{desktop_store_servers, parse_registry, project_file_servers};
use super::{McpServerConfig, McpServerEntry, DESKTOP_STORE_KEY};
use crate::acp::mcp_probe::McpNameValuePair;
use crate::automation::engine::ProjectRoots;
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

fn roots_at(root: &Path) -> ProjectRoots {
    let root = root.to_path_buf();
    Arc::new(move |project_id| (project_id == "p1").then(|| root.clone()))
}

fn write_project_file(root: &Path, value: &Value) {
    let dir = root.join(".termul");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("mcp-servers.json"), value.to_string()).unwrap();
}

#[test]
fn termul_server_reads_the_project_file() {
    let root = tempfile::tempdir().unwrap();
    let servers = project_file_servers(roots_at(root.path()));
    assert_eq!(servers("p1"), vec![]);
    write_project_file(root.path(), &stored_list());
    assert_eq!(
        ids(&servers("p1")),
        vec![("srv-1", "Files"), ("srv-3", "Remote")]
    );
    assert_eq!(servers("other"), vec![]);
    std::fs::write(root.path().join(".termul/mcp-servers.json"), "{not json").unwrap();
    assert_eq!(servers("p1"), vec![]);
    let oversized = format!("[{}]", " ".repeat(crate::web::mcp_servers_api::MAX_REGISTRY_BYTES));
    std::fs::write(root.path().join(".termul/mcp-servers.json"), oversized).unwrap();
    assert_eq!(servers("p1"), vec![]);
}

#[test]
fn desktop_reads_the_store_key_and_falls_back_to_the_project_file() {
    let root = tempfile::tempdir().unwrap();
    write_project_file(
        root.path(),
        &json!([{ "id": "file-1", "name": "From file", "command": "x" }]),
    );
    let store =
        Arc::new(WebStore::open(root.path().join("store.json"), StorePolicy::default()).unwrap());
    let servers = desktop_store_servers(store.clone(), roots_at(root.path()));
    assert_eq!(ids(&servers("p1")), vec![("file-1", "From file")]);

    let desktop = ClientIdentity {
        device_id: "desktop-device".into(),
        client_instance_id: "tab-1".into(),
    };
    store
        .write(
            DESKTOP_STORE_KEY,
            json!({ "_version": 1, "data": stored_list() }),
            Precondition::default(),
            &desktop,
            1,
        )
        .unwrap();
    assert_eq!(
        ids(&servers("p1")),
        vec![("srv-1", "Files"), ("srv-3", "Remote")]
    );
    assert_eq!(
        ids(&servers("any-project")),
        vec![("srv-1", "Files"), ("srv-3", "Remote")]
    );
}

#[test]
fn desktop_falls_back_to_the_project_file_when_the_store_value_is_not_a_list() {
    let root = tempfile::tempdir().unwrap();
    write_project_file(
        root.path(),
        &json!([{ "id": "file-1", "name": "From file", "command": "x" }]),
    );
    let store =
        Arc::new(WebStore::open(root.path().join("store.json"), StorePolicy::default()).unwrap());
    let desktop = ClientIdentity {
        device_id: "desktop-device".into(),
        client_instance_id: "tab-1".into(),
    };
    store
        .write(
            DESKTOP_STORE_KEY,
            json!({ "_version": 1, "data": "not a list" }),
            Precondition::default(),
            &desktop,
            1,
        )
        .unwrap();
    let servers = desktop_store_servers(store, roots_at(root.path()));
    assert_eq!(ids(&servers("p1")), vec![("file-1", "From file")]);
}
