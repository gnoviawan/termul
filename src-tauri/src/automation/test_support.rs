use serde_json::{json, Value};

use super::graph::apply_ops;
use super::model::{Automation, AutomationId, Graph, NodeId, Op, Trigger};

pub fn node_id(id: &str) -> NodeId {
    NodeId::parse(id).unwrap()
}

pub fn ops(value: Value) -> Vec<Op> {
    serde_json::from_value(value).unwrap()
}

pub fn apply(a: &Automation, value: Value) -> Automation {
    apply_ops(a, &ops(value)).unwrap()
}

/// A weekday-morning automation that passes every rule: fetch with a key,
/// have an agent extract, branch, shape, and post.
pub fn sample_automation() -> Automation {
    let graph: Graph = serde_json::from_value(json!({
        "nodes": [
            { "id": "fetch", "label": "Fetch items", "spec": {
                "kind": "http", "method": "GET",
                "url": "https://api.example.com/items?since={{trigger.scheduled_for}}",
                "headers": [{ "name": "Authorization", "value": "Bearer {{secrets.API_KEY}}" }],
                "body": null,
                "allowed_hosts": ["api.example.com"] } },
            { "id": "extract", "label": "Extract", "spec": {
                "kind": "agent", "agent_id": "claude", "model": "sonnet",
                "prompt": "Summarize {{nodes.fetch.output.items}}",
                "output_schema": { "type": "object",
                    "properties": { "summary": { "type": "string" }, "urgent": { "type": "boolean" } },
                    "required": ["summary", "urgent"] },
                "timeout_ms": 120000, "max_attempts": 2 } },
            { "id": "check", "label": "Urgent?", "spec": {
                "kind": "condition", "left": "{{nodes.extract.output.urgent}}", "op": "eq", "right": "true" } },
            { "id": "shape", "label": "Shape", "spec": {
                "kind": "transform", "fields": [{ "name": "text", "value": "{{nodes.extract.output.summary}}" }] } },
            { "id": "post", "label": "Notify", "spec": {
                "kind": "http", "method": "POST", "url": "https://hooks.example.com/notify",
                "headers": [{ "name": "X-Key", "value": "{{secrets.HOOK_KEY}}" }],
                "body": "{{nodes.shape.output}}",
                "allowed_hosts": ["hooks.example.com"] } },
            { "id": "alert", "label": "Fetch failed", "spec": { "kind": "fail", "message": "fetch failed" } }
        ],
        "edges": [
            { "from": "trigger", "port": "out", "to": "fetch" },
            { "from": "fetch", "port": "out", "to": "extract" },
            { "from": "fetch", "port": "error", "to": "alert" },
            { "from": "extract", "port": "out", "to": "check" },
            { "from": "check", "port": "true", "to": "shape" },
            { "from": "shape", "port": "out", "to": "post" }
        ]
    }))
    .unwrap();
    let mut a = Automation::new("project-1".into(), "Morning digest".into(), 1_000);
    a.id = AutomationId::from("auto-1".to_string());
    a.graph = graph;
    a.trigger = serde_json::from_value::<Trigger>(json!({
        "kind": "schedule",
        "schedule": { "kind": "cron", "expr": "0 5 * * 1-5", "timezone": "America/New_York" }
    }))
    .unwrap();
    a
}

pub use engine_support::*;

mod engine_support {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    use parking_lot::Mutex;

    use crate::acp::AcpManager;
    use crate::automation::agents::AgentRegistry;
    use crate::automation::engine::{Clock, Engine, EngineDeps, HttpConfig};
    use crate::automation::secrets::{SecretError, SecretVault, Secrets};
    use crate::automation::store::AutomationStore;

    #[derive(Default)]
    pub struct FakeClock(AtomicI64);

    impl FakeClock {
        pub fn at(ms: i64) -> Arc<Self> {
            Arc::new(Self(AtomicI64::new(ms)))
        }

        pub fn set(&self, ms: i64) {
            self.0.store(ms, Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// A keychain in a map; `unavailable` makes every call fail like a
    /// locked keychain.
    #[derive(Default)]
    pub struct MemoryVault {
        pub entries: Mutex<HashMap<String, String>>,
        pub unavailable: bool,
    }

    impl SecretVault for MemoryVault {
        fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
            if self.unavailable {
                return Err(SecretError::KeychainUnavailable);
            }
            Ok(self.entries.lock().get(account).cloned())
        }

        fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
            if self.unavailable {
                return Err(SecretError::KeychainUnavailable);
            }
            self.entries
                .lock()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SecretError> {
            if self.unavailable {
                return Err(SecretError::KeychainUnavailable);
            }
            self.entries.lock().remove(account);
            Ok(())
        }
    }

    pub struct TestEngine {
        pub engine: Arc<Engine>,
        pub clock: Arc<FakeClock>,
        pub store: Arc<AutomationStore>,
        pub agents: Arc<AgentRegistry>,
        pub secrets: Arc<Secrets>,
    }

    /// An engine on an in-memory store whose every project resolves to
    /// `root`.
    pub fn test_engine(
        root: PathBuf,
        vault: Arc<dyn SecretVault>,
        http: HttpConfig,
    ) -> TestEngine {
        let store = Arc::new(AutomationStore::open_in_memory().unwrap());
        let clock = FakeClock::at(1_000);
        let agents = Arc::new(AgentRegistry::in_memory());
        let secrets = Arc::new(Secrets::new(vault, store.clone()));
        let engine = Engine::new(EngineDeps {
            store: store.clone(),
            agents: agents.clone(),
            secrets: secrets.clone(),
            acp: Arc::new(AcpManager::new(vec![])),
            project_roots: Arc::new(move |_| Some(root.clone())),
            clock: clock.clone(),
            http,
        })
        .unwrap();
        TestEngine {
            engine,
            clock,
            store,
            agents,
            secrets,
        }
    }
}
