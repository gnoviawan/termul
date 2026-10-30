//! The run policy the approval card renders, derived from an automation.

use chrono::{TimeZone, Utc};

use super::graph;
use super::model::{
    AgentPolicy, AgentTools, Automation, NodeHosts, NodeSecrets, NodeSpec, RunPolicy, Schedule,
    Trigger,
};
use super::schedule::{next_runs, BACKOFF_LADDER_MS};

const PREVIEW_RUNS: usize = 3;

pub fn run_policy(automation: &Automation, now_ms: i64) -> RunPolicy {
    let graph = &automation.graph;
    let mut agents = Vec::new();
    let mut secrets = Vec::new();
    let mut outbound_hosts = Vec::new();
    for node in &graph.nodes {
        match &node.spec {
            NodeSpec::Agent {
                agent_id,
                model,
                timeout_ms,
                ..
            } => agents.push(AgentPolicy {
                node_id: node.id.clone(),
                agent_id: agent_id.clone(),
                model: model.clone(),
                timeout_ms: *timeout_ms,
                tools: AgentTools::None,
            }),
            NodeSpec::Http { allowed_hosts, .. } => {
                let names = graph::secret_names(&node.spec);
                if !names.is_empty() {
                    secrets.push(NodeSecrets {
                        node_id: node.id.clone(),
                        names,
                    });
                }
                outbound_hosts.push(NodeHosts {
                    node_id: node.id.clone(),
                    hosts: allowed_hosts.clone(),
                });
            }
            NodeSpec::Transform { .. } | NodeSpec::Condition { .. } | NodeSpec::Fail { .. } => {}
        }
    }
    RunPolicy {
        trigger_summary: trigger_summary(&automation.trigger),
        next_runs: automation
            .schedule()
            .and_then(|s| next_runs(s, now_ms, PREVIEW_RUNS).ok())
            .unwrap_or_default(),
        agents,
        secrets,
        outbound_hosts,
        untrusted_flow: graph::untrusted_flow(graph),
        failure_policy: failure_policy(),
    }
}

fn trigger_summary(trigger: &Trigger) -> String {
    match trigger {
        Trigger::Manual => "manual only".to_string(),
        Trigger::Schedule {
            schedule: Schedule::Cron { expr, timezone },
        } => format!("cron \"{expr}\" in {timezone}"),
        Trigger::Schedule {
            schedule:
                Schedule::Every {
                    every_ms,
                    anchor_ms,
                },
        } => format!("every {} from {}", duration(*every_ms), instant(*anchor_ms)),
        Trigger::Schedule {
            schedule: Schedule::At { at },
        } => format!("once at {}", instant(*at)),
    }
}

fn failure_policy() -> String {
    let rungs: Vec<String> = BACKOFF_LADDER_MS
        .iter()
        .map(|ms| match ms % 60_000 {
            0 => format!("{}m", ms / 60_000),
            _ => format!("{}s", ms / 1_000),
        })
        .collect();
    format!("backoff {}", rungs.join("/"))
}

fn duration(ms: u64) -> String {
    const UNITS: [(u64, &str); 5] = [
        (86_400_000, "d"),
        (3_600_000, "h"),
        (60_000, "m"),
        (1_000, "s"),
        (1, "ms"),
    ];
    UNITS
        .iter()
        .find(|(size, _)| ms >= *size && ms.is_multiple_of(*size))
        .map(|(size, unit)| format!("{}{unit}", ms / size))
        .unwrap_or_else(|| format!("{ms}ms"))
}

fn instant(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%dT%H:%MZ").to_string())
        .unwrap_or_else(|| ms.to_string())
}
