//! The `automation_*` tools as an agent calls them: an MCP client on the
//! child's stdio transport, through the real parent, to an in-memory
//! automation service.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::tests::{
    handshake_config, list_tools, read_json_id, send_line, with_mcp_session, ClientReader,
    ClientWriter,
};
use crate::acp::config::AgentConfig;
use crate::acp::host_mcp::gateway_harness::Harness;
use crate::acp::session_persistence::UNASSIGNED_PROJECT_ID;
use crate::automation::engine::HttpConfig;
use crate::automation::model::{AutomationChanged, AutomationId};
use crate::automation::service::AutomationService;
use crate::automation::test_support::{no_history, test_engine, MemoryVault};

fn service() -> Arc<AutomationService> {
    let engine = test_engine(
        std::env::temp_dir(),
        Arc::new(MemoryVault::default()),
        HttpConfig::default(),
    )
    .engine;
    Arc::new(AutomationService::new(engine, no_history()))
}

/// An agent's side of one MCP session.
struct Agent {
    writer: ClientWriter,
    reader: ClientReader,
    next_id: i64,
}

impl Agent {
    fn new(writer: ClientWriter, reader: ClientReader) -> Self {
        Self {
            writer,
            reader,
            next_id: 100,
        }
    }

    /// `(is_error, text)` of one `tools/call`.
    async fn call(&mut self, name: &str, arguments: Value) -> (bool, String) {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        send_line(&mut self.writer, &request.to_string()).await;
        let reply = read_json_id(&mut self.reader, id).await;
        assert!(reply.get("error").is_none(), "{name}: {reply}");
        let text = reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("{name}: no text in {reply}"))
            .to_string();
        (reply["result"]["isError"] == true, text)
    }

    async fn text(&mut self, name: &str, arguments: Value) -> String {
        let (is_error, text) = self.call(name, arguments).await;
        assert!(!is_error, "{name} failed: {text}");
        text
    }

    async fn ok(&mut self, name: &str, arguments: Value) -> Value {
        serde_json::from_str(&self.text(name, arguments).await).expect("JSON result")
    }

    async fn refused(&mut self, name: &str, arguments: Value) -> Value {
        let (is_error, text) = self.call(name, arguments).await;
        assert!(is_error, "{name} should fail: {text}");
        serde_json::from_str(&text).expect("JSON refusal")
    }
}

fn codes(issues: &Value) -> Vec<&str> {
    issues
        .as_array()
        .expect("issues array")
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect()
}

fn approved_revision(service: &AutomationService, id: &str) -> Option<u64> {
    service
        .get(&AutomationId::from(id.to_string()))
        .unwrap()
        .automation
        .approved_revision
}

fn fetch_node(allowed_hosts: Value) -> Value {
    json!({ "id": "fetch", "label": "Fetch", "spec": {
        "kind": "http", "method": "GET", "url": "https://api.example.com/items",
        "headers": [], "allowed_hosts": allowed_hosts } })
}

#[test]
fn an_agent_builds_fixes_and_proposes_an_automation_that_stays_unapproved() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    service.engine().agents().record(&AgentConfig {
        config_id: Some("test".to_string()),
        name: "Test agent".to_string(),
        command: "/opt/agents/launch-test".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
        allow_terminal: false,
    });
    let mut changes = service.subscribe();
    let svc = service.clone();
    harness
        .runtime
        .block_on(with_mcp_session(configs[0].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let created = agent
                .ok("automation_create", json!({ "name": "Digest" }))
                .await;
            let id = created["id"].as_str().unwrap().to_string();
            assert_eq!(created["project_id"], "proj-1");
            assert_eq!(created["revision"], 1);
            assert_eq!(approved_revision(&svc, &id), None);

            let applied = agent
                .ok(
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 1, "ops": [
                        { "op": "add_node", "node": fetch_node(json!([])) },
                        { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "fetch" } }
                    ] }),
                )
                .await;
            assert_eq!(applied["automation"]["revision"], 2);
            assert_eq!(codes(&applied["issues"]), ["host_not_allowed"]);
            assert_eq!(approved_revision(&svc, &id), None);

            let detail = agent.ok("automation_get", json!({ "id": id })).await;
            assert_eq!(codes(&detail["issues"]), ["host_not_allowed"]);
            assert_eq!(detail["automation"]["graph"]["nodes"][0]["id"], "fetch");
            assert_eq!(detail["policy"]["untrusted_flow"], false);

            let refused = agent
                .refused("automation_propose", json!({ "id": id }))
                .await;
            assert_eq!(refused["code"], "has_issues");
            assert_eq!(codes(&refused["issues"]), ["host_not_allowed"]);

            let fixed = agent
                .ok(
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 2, "ops": [
                        { "op": "update_node", "id": "fetch",
                          "spec": fetch_node(json!(["api.example.com"]))["spec"] }
                    ] }),
                )
                .await;
            assert_eq!(fixed["automation"]["revision"], 3);
            assert_eq!(fixed["issues"], json!([]));

            let listed = agent.ok("automation_list", json!({})).await;
            assert_eq!(
                listed,
                json!({ "automations": [{
                    "id": id, "name": "Digest", "revision": 3, "approved_revision": null,
                    "enabled": true, "trigger": { "kind": "manual" }, "nodes": 1
                }] })
            );

            let proposed = agent.text("automation_propose", json!({ "id": id })).await;
            assert_eq!(
                proposed,
                "Proposed \"Digest\" (revision 3) for review. Tell the user it is waiting in \
the Automations tab: they review its run policy (schedule, agents, secrets, outbound hosts) and \
approve it there. It does not run until they approve it. Any further edit creates a new revision \
that needs approval again."
            );
            assert_eq!(approved_revision(&svc, &id), None);

            svc.set_enabled(&AutomationId::from(id.clone()), false)
                .unwrap();
            let proposed = agent.text("automation_propose", json!({ "id": id })).await;
            assert!(
                proposed.contains(" It does not run until they approve and enable it. "),
                "{proposed}"
            );
        }));

    let id = service.list("proj-1").unwrap()[0].id.clone();
    let proposals: Vec<AutomationChanged> = std::iter::from_fn(|| changes.try_recv().ok())
        .filter(|change| change.proposed)
        .collect();
    let proposal = AutomationChanged {
        project_id: "proj-1".to_string(),
        automation_id: Some(id.clone()),
        proposed: true,
        proposed_by: Some("Test agent".to_string()),
    };
    assert_eq!(proposals, [proposal.clone(), proposal]);
    let stored = service.get(&id).unwrap().automation;
    assert_eq!((stored.revision, stored.approved_revision), (3, None));
    assert!(!stored.armed());
}

#[test]
fn another_projects_automation_is_not_found() {
    let (harness, configs) =
        Harness::new(&[("sess-1", Some("proj-1")), ("sess-2", Some("proj-2"))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    let foreign = service.create("proj-1", "Theirs").unwrap();
    let id = foreign.id.to_string();
    harness
        .runtime
        .block_on(with_mcp_session(configs[1].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let ops = json!([{ "op": "rename", "name": "Mine" }]);
            for (tool, arguments) in [
                ("automation_get", json!({ "id": id })),
                (
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 1, "ops": ops }),
                ),
                ("automation_propose", json!({ "id": id })),
            ] {
                let refused = agent.refused(tool, arguments).await;
                assert_eq!(refused["code"], "not_found", "{tool}");
                assert_eq!(refused["message"], format!("{id} not found"), "{tool}");
            }
            let listed = agent.ok("automation_list", json!({})).await;
            assert_eq!(listed, json!({ "automations": [] }));
        }));
    let untouched = service.get(&foreign.id).unwrap().automation;
    assert_eq!((untouched.name.as_str(), untouched.revision), ("Theirs", 1));
}

#[test]
fn a_token_authors_in_its_own_sessions_project_while_its_agent_has_another_turn() {
    let (harness, configs) =
        Harness::new(&[("sess-1", Some("proj-1")), ("sess-2", Some("proj-2"))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    let theirs = service.create("proj-2", "Theirs").unwrap();
    harness.server().begin_turn(&configs[0].agent_id, "sess-2");
    harness
        .runtime
        .block_on(with_mcp_session(configs[0].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let listed = agent.ok("automation_list", json!({})).await;
            assert_eq!(listed, json!({ "automations": [] }));
            let created = agent
                .ok("automation_create", json!({ "name": "Mine" }))
                .await;
            assert_eq!(created["project_id"], "proj-1");
        }));
    let names = |project: &str| -> Vec<String> {
        service
            .list(project)
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect()
    };
    assert_eq!(names("proj-1"), ["Mine"]);
    assert_eq!(names("proj-2"), [theirs.name]);
}

#[test]
fn a_stale_revision_returns_the_current_one_and_a_bad_op_saves_nothing() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    let created = service.create("proj-1", "Digest").unwrap();
    let id = created.id.to_string();
    harness
        .runtime
        .block_on(with_mcp_session(configs[0].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let rename = json!([{ "op": "rename", "name": "Morning digest" }]);
            let applied = agent
                .ok(
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 1, "ops": rename }),
                )
                .await;
            assert_eq!(applied["automation"]["revision"], 2);

            let stale = agent
                .refused(
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 1, "ops": rename }),
                )
                .await;
            assert_eq!(stale["code"], "revision_conflict");
            assert_eq!(stale["current_revision"], 2);

            let bad = agent
                .refused(
                    "automation_apply_ops",
                    json!({ "id": id, "base_revision": 2, "ops": [
                        { "op": "rename", "name": "Kept" },
                        { "op": "launch", "target": "moon" }
                    ] }),
                )
                .await;
            assert_eq!(bad["code"], "invalid_ops");
            assert!(
                bad["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("op 1: unknown variant `launch`"),
                "{bad}"
            );
        }));
    let stored = service.get(&created.id).unwrap().automation;
    assert_eq!(
        (stored.name.as_str(), stored.revision),
        ("Morning digest", 2)
    );
}

#[test]
fn capabilities_name_agents_and_secrets_without_launch_details() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    service.engine().agents().record(&AgentConfig {
        config_id: Some("test".to_string()),
        name: "Test agent".to_string(),
        command: "/opt/agents/launch-test".to_string(),
        args: vec!["--token".to_string(), "arg-secret".to_string()],
        env: HashMap::from([("API_KEY".to_string(), "env-secret".to_string())]),
        allow_terminal: false,
    });
    service
        .set_secret("proj-1", "HOOK_KEY", "vault-secret")
        .unwrap();
    service
        .set_secret("proj-2", "OTHER_KEY", "other-secret")
        .unwrap();
    harness
        .runtime
        .block_on(with_mcp_session(configs[0].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let text = agent.text("automation_capabilities", json!({})).await;
            for leaked in [
                "launch-test",
                "arg-secret",
                "env-secret",
                "vault-secret",
                "OTHER_KEY",
            ] {
                assert!(!text.contains(leaked), "{leaked} in {text}");
            }
            assert_eq!(
                serde_json::from_str::<Value>(&text).unwrap(),
                json!({
                    "agents": [{ "agent_id": "test", "name": "Test agent" }],
                    "secret_names": ["HOOK_KEY"],
                    "calling_agent_id": "test",
                })
            );
        }));
}

#[test]
fn the_guide_carries_the_secrets_and_question_rules() {
    let (harness, configs) = Harness::new(&[("sess-1", Some("proj-1"))]);
    harness.server().use_automation_service(service());
    harness
        .runtime
        .block_on(with_mcp_session(configs[0].clone(), |w, r| async move {
            let mut agent = Agent::new(w, r);
            let guide = agent.text("automation_guide", json!({})).await;
            for rule in [
                "Never ask for a secret value",
                "Secrets dialog",
                "{{secrets.NAME}} goes only in an http node's url, headers or body.",
                "ask at most 5 typed questions",
                "\"you decide\"",
                "Agent nodes run with no tools and no secrets",
                "call automation_propose(id)",
            ] {
                assert!(guide.contains(rule), "missing {rule:?}");
            }
        }));
}

#[test]
fn a_chat_outside_a_project_cannot_author() {
    let (harness, configs) =
        Harness::new(&[("sess-1", None), ("sess-2", Some(UNASSIGNED_PROJECT_ID))]);
    let service = service();
    harness.server().use_automation_service(service.clone());
    for config in configs {
        harness
            .runtime
            .block_on(with_mcp_session(config, |w, r| async move {
                let mut agent = Agent::new(w, r);
                let refused = agent
                    .refused("automation_create", json!({ "name": "Digest" }))
                    .await;
                assert_eq!(refused["code"], "no_project");
            }));
    }
    assert!(service.list(UNASSIGNED_PROJECT_ID).unwrap().is_empty());
}

#[tokio::test]
async fn the_seven_authoring_tools_are_listed_and_none_can_arm() {
    let tools = list_tools(handshake_config()).await;
    let mut names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .filter(|name| name.starts_with("automation_"))
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "automation_apply_ops",
            "automation_capabilities",
            "automation_create",
            "automation_get",
            "automation_guide",
            "automation_list",
            "automation_propose",
        ]
    );
    let required = |name: &str| -> Vec<String> {
        let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
        let mut required: Vec<String> = tool["inputSchema"]["required"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect()
            })
            .unwrap_or_default();
        required.sort_unstable();
        required
    };
    assert_eq!(
        required("automation_apply_ops"),
        ["base_revision", "id", "ops"]
    );
    assert_eq!(required("automation_create"), ["name"]);
    assert_eq!(required("automation_get"), ["id"]);
    assert_eq!(required("automation_propose"), ["id"]);
    assert!(required("automation_capabilities").is_empty());
}
