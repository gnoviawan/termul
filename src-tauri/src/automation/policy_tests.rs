use serde_json::json;

use super::model::{AgentPolicy, AgentTools, NodeHosts, NodeSecrets, RunPolicy};
use super::policy::run_policy;
use super::test_support::{apply, node_id, sample_automation};

#[test]
fn derives_the_approval_card_for_the_sample() {
    // 2026-03-06T12:00Z, a Friday; next weekday 05:00 New York slots follow DST.
    let policy = run_policy(&sample_automation(), 1_772_798_400_000);
    assert_eq!(
        policy,
        RunPolicy {
            trigger_summary: "cron \"0 5 * * 1-5\" in America/New_York".into(),
            next_runs: vec![1_773_046_800_000, 1_773_133_200_000, 1_773_219_600_000],
            agents: vec![AgentPolicy {
                node_id: node_id("extract"),
                agent_id: "claude".into(),
                model: Some("sonnet".into()),
                timeout_ms: 120_000,
                tools: AgentTools::None,
            }],
            secrets: vec![
                NodeSecrets {
                    node_id: node_id("fetch"),
                    names: vec!["API_KEY".into()],
                },
                NodeSecrets {
                    node_id: node_id("post"),
                    names: vec!["HOOK_KEY".into()],
                },
            ],
            outbound_hosts: vec![
                NodeHosts {
                    node_id: node_id("fetch"),
                    hosts: vec!["api.example.com".into()],
                },
                NodeHosts {
                    node_id: node_id("post"),
                    hosts: vec!["hooks.example.com".into()],
                },
            ],
            untrusted_flow: true,
            failure_policy: "backoff 30s/1m/5m/15m/60m".into(),
        }
    );
}

#[test]
fn summarizes_manual_every_and_at_triggers() {
    let base = sample_automation();
    let summary = |trigger: serde_json::Value| {
        let a = apply(&base, json!([{ "op": "set_trigger", "trigger": trigger }]));
        let p = run_policy(&a, 0);
        (p.trigger_summary, p.next_runs)
    };
    assert_eq!(
        summary(json!({ "kind": "manual" })),
        ("manual only".into(), vec![])
    );
    assert_eq!(
        summary(
            json!({ "kind": "schedule", "schedule": { "kind": "every", "every_ms": 900000, "anchor_ms": 0 } })
        ),
        (
            "every 15m from 1970-01-01T00:00Z".into(),
            vec![900_000, 1_800_000, 2_700_000]
        )
    );
    assert_eq!(
        summary(
            json!({ "kind": "schedule", "schedule": { "kind": "at", "at": 1_772_798_400_000_i64 } })
        ),
        ("once at 2026-03-06T12:00Z".into(), vec![1_772_798_400_000])
    );
}
