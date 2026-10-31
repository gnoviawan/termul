//! Pure graph rules: structural validation, op application and ordering.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;

use super::model::{
    wire_name, Automation, ConditionOp, EdgeSource, Graph, HttpMethod, Issue, IssueCode, NodeId,
    NodeKind, NodeSpec, Op, Port, Trigger, AGENT_MAX_ATTEMPTS, AGENT_MAX_TIMEOUT_MS,
};
use super::template::{self, ParsedTemplate, Reference};
use super::{schedule, schema};

/// Every rule the contract lists, except the agent registry lookup, which
/// needs the service. Empty means the automation can be approved.
pub fn validate(automation: &Automation) -> Vec<Issue> {
    let mut issues = Vec::new();
    if let Trigger::Schedule { schedule } = &automation.trigger {
        if let Err(e) = schedule::check(schedule) {
            issues.push(issue(None, IssueCode::InvalidSchedule, e.to_string()));
        }
    }
    let graph = &automation.graph;
    check_unique_ids(graph, &mut issues);
    check_edges(graph, &mut issues);
    check_cycles_and_reachability(graph, &mut issues);
    for node in &graph.nodes {
        check_node(graph, &node.id, &node.spec, &mut issues);
    }
    issues
}

fn issue(node_id: Option<&NodeId>, code: IssueCode, message: impl Into<String>) -> Issue {
    Issue {
        node_id: node_id.cloned(),
        code,
        message: message.into(),
    }
}

fn check_unique_ids(graph: &Graph, issues: &mut Vec<Issue>) {
    let mut seen = HashSet::new();
    for node in &graph.nodes {
        if !seen.insert(&node.id) {
            issues.push(issue(
                Some(&node.id),
                IssueCode::DuplicateNodeId,
                format!("node id {} is used more than once", node.id),
            ));
        }
    }
}

fn legal_ports(source: Option<NodeKind>) -> &'static [Port] {
    match source {
        None => &[Port::Out],
        Some(NodeKind::Condition) => &[Port::True, Port::False, Port::Error],
        Some(NodeKind::Fail) => &[],
        Some(NodeKind::Http | NodeKind::Agent | NodeKind::Transform) => &[Port::Out, Port::Error],
    }
}

fn check_edges(graph: &Graph, issues: &mut Vec<Issue>) {
    let mut trigger_edges = 0;
    for edge in &graph.edges {
        let source_kind = match &edge.from {
            EdgeSource::Trigger => {
                trigger_edges += 1;
                None
            }
            EdgeSource::Node(id) => match graph.node(id) {
                Some(node) => Some(node.spec.kind()),
                None => {
                    issues.push(issue(
                        Some(id),
                        IssueCode::UnknownEdgeEndpoint,
                        format!("edge starts at unknown node {id}"),
                    ));
                    continue;
                }
            },
        };
        if graph.node(&edge.to).is_none() {
            issues.push(issue(
                Some(&edge.to),
                IssueCode::UnknownEdgeEndpoint,
                format!("edge ends at unknown node {}", edge.to),
            ));
        }
        if !legal_ports(source_kind).contains(&edge.port) {
            let from: String = edge.from.clone().into();
            issues.push(issue(
                match &edge.from {
                    EdgeSource::Node(id) => Some(id),
                    EdgeSource::Trigger => None,
                },
                IssueCode::IllegalPort,
                format!("{from} has no {} port", wire_name(&edge.port)),
            ));
        }
    }
    if trigger_edges != 1 {
        issues.push(issue(
            None,
            IssueCode::TriggerEdgeCount,
            format!("expected exactly one edge from trigger, found {trigger_edges}"),
        ));
    }
}

/// Node-to-node adjacency over edges whose endpoints both exist.
fn children(graph: &Graph) -> HashMap<&NodeId, Vec<&NodeId>> {
    let ids: HashSet<&NodeId> = graph.nodes.iter().map(|n| &n.id).collect();
    let mut out: HashMap<&NodeId, Vec<&NodeId>> = HashMap::new();
    for edge in &graph.edges {
        if let EdgeSource::Node(from) = &edge.from {
            if ids.contains(from) && ids.contains(&edge.to) {
                out.entry(from).or_default().push(&edge.to);
            }
        }
    }
    out
}

fn reach<'a>(
    starts: impl IntoIterator<Item = &'a NodeId>,
    adjacency: &HashMap<&'a NodeId, Vec<&'a NodeId>>,
) -> HashSet<&'a NodeId> {
    let mut seen = HashSet::new();
    let mut queue: VecDeque<&NodeId> = starts.into_iter().collect();
    while let Some(id) = queue.pop_front() {
        for next in adjacency.get(id).into_iter().flatten() {
            if seen.insert(*next) {
                queue.push_back(next);
            }
        }
    }
    seen
}

/// Nodes with a path to `id`, not counting `id` itself unless it sits on a cycle.
pub fn ancestors<'a>(graph: &'a Graph, id: &NodeId) -> HashSet<&'a NodeId> {
    let mut parents: HashMap<&NodeId, Vec<&NodeId>> = HashMap::new();
    for (from, tos) in children(graph) {
        for to in tos {
            parents.entry(to).or_default().push(from);
        }
    }
    let Some(start) = graph.nodes.iter().map(|n| &n.id).find(|n| *n == id) else {
        return HashSet::new();
    };
    reach([start], &parents)
}

pub fn descendants<'a>(graph: &'a Graph, id: &NodeId) -> HashSet<&'a NodeId> {
    let Some(start) = graph.nodes.iter().map(|n| &n.id).find(|n| *n == id) else {
        return HashSet::new();
    };
    reach([start], &children(graph))
}

fn check_cycles_and_reachability(graph: &Graph, issues: &mut Vec<Issue>) {
    let adjacency = children(graph);
    for node in &graph.nodes {
        if reach([&node.id], &adjacency).contains(&node.id) {
            issues.push(issue(
                Some(&node.id),
                IssueCode::Cycle,
                format!("node {} is part of a cycle", node.id),
            ));
        }
    }
    let roots: Vec<&NodeId> = graph
        .edges
        .iter()
        .filter(|e| e.from == EdgeSource::Trigger)
        .map(|e| &e.to)
        .collect();
    let mut reachable = reach(roots.iter().copied(), &adjacency);
    reachable.extend(roots);
    for node in &graph.nodes {
        if !reachable.contains(&node.id) {
            issues.push(issue(
                Some(&node.id),
                IssueCode::Unreachable,
                format!("node {} is not reachable from the trigger", node.id),
            ));
        }
    }
}

fn check_node(graph: &Graph, id: &NodeId, spec: &NodeSpec, issues: &mut Vec<Issue>) {
    let node_ancestors = ancestors(graph, id);
    for (field, source) in spec.templates() {
        let parsed = match template::parse(source.as_str()) {
            Ok(parsed) => parsed,
            Err(e) => {
                issues.push(issue(
                    Some(id),
                    IssueCode::InvalidTemplate,
                    format!("{field}: {e}"),
                ));
                continue;
            }
        };
        for reference in parsed.references() {
            match reference {
                Reference::NodeOutput { node, .. } if graph.node(node).is_none() => {
                    issues.push(issue(
                        Some(id),
                        IssueCode::UnknownNodeReference,
                        format!("{field} references unknown node {node}"),
                    ));
                }
                Reference::NodeOutput { node, .. } if !node_ancestors.contains(node) => {
                    issues.push(issue(
                        Some(id),
                        IssueCode::NonAncestorReference,
                        format!("{field} references {node}, which does not run before {id}"),
                    ));
                }
                Reference::Secret(name) if spec.kind() != NodeKind::Http => {
                    issues.push(issue(
                        Some(id),
                        IssueCode::SecretNotAllowed,
                        format!("{field} uses secrets.{name}; secrets are only allowed in http url, headers and body"),
                    ));
                }
                _ => {}
            }
        }
        if field == "url" {
            if let NodeSpec::Http { allowed_hosts, .. } = spec {
                check_http_host(id, &parsed, allowed_hosts, issues);
            }
        }
    }
    match spec {
        NodeSpec::Agent {
            output_schema,
            timeout_ms,
            max_attempts,
            ..
        } => {
            if let Err(e) = schema::parse(&output_schema.0) {
                issues.push(issue(
                    Some(id),
                    IssueCode::InvalidOutputSchema,
                    format!("output_schema {e}"),
                ));
            }
            if *timeout_ms == 0 || *timeout_ms > AGENT_MAX_TIMEOUT_MS {
                issues.push(issue(
                    Some(id),
                    IssueCode::AgentTimeoutOutOfRange,
                    format!("timeout_ms must be 1..={AGENT_MAX_TIMEOUT_MS}, got {timeout_ms}"),
                ));
            }
            if !(1..=AGENT_MAX_ATTEMPTS).contains(max_attempts) {
                issues.push(issue(
                    Some(id),
                    IssueCode::AgentMaxAttemptsOutOfRange,
                    format!("max_attempts must be 1..={AGENT_MAX_ATTEMPTS}, got {max_attempts}"),
                ));
            }
        }
        NodeSpec::Condition {
            op, right: None, ..
        } if *op != ConditionOp::Exists => {
            issues.push(issue(
                Some(id),
                IssueCode::MissingConditionOperand,
                format!("condition {} needs a right operand", wire_name(op)),
            ));
        }
        _ => {}
    }
}

/// Stands in for every hole while the URL is parsed, so a templated host
/// shows up as this marker in the parsed host.
const HOLE_MARKER: &str = "termul-template-hole";

/// The URL's literal host, or `None` when a hole decides the host.
pub fn literal_host(url: &ParsedTemplate) -> Result<Option<String>, String> {
    let text = url.with_holes_as(HOLE_MARKER);
    match url::Url::parse(&text) {
        Ok(parsed) if !matches!(parsed.scheme(), "http" | "https") => Err(format!(
            "scheme must be http or https, got {:?}",
            parsed.scheme()
        )),
        Ok(parsed) => match parsed.host_str() {
            Some(host) if host.contains(HOLE_MARKER) => Ok(None),
            Some(host) => Ok(Some(host.to_ascii_lowercase())),
            None => Err("url has no host".to_string()),
        },
        Err(_) if url.has_holes() => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn check_http_host(id: &NodeId, url: &ParsedTemplate, allowed: &[String], issues: &mut Vec<Issue>) {
    match literal_host(url) {
        Err(reason) => issues.push(issue(Some(id), IssueCode::InvalidUrl, reason)),
        Ok(Some(host)) if !allowed.iter().any(|a| a.eq_ignore_ascii_case(&host)) => {
            issues.push(issue(
                Some(id),
                IssueCode::HostNotAllowed,
                format!("host {host} is not in allowed_hosts"),
            ));
        }
        Ok(None) if allowed.is_empty() => issues.push(issue(
            Some(id),
            IssueCode::TemplatedHostWithoutAllowlist,
            "the url host comes from a template, so allowed_hosts must list the hosts it may reach",
        )),
        Ok(_) => {}
    }
}

/// True when untrusted fetched content can steer an outbound request: an
/// agent whose prompt reads data derived from a GET response has an http
/// node downstream of it.
pub fn untrusted_flow(graph: &Graph) -> bool {
    let refs: HashMap<&NodeId, Vec<NodeId>> = graph
        .nodes
        .iter()
        .map(|n| (&n.id, referenced_nodes(&n.spec)))
        .collect();
    let mut tainted: HashSet<&NodeId> = graph
        .nodes
        .iter()
        .filter(|n| {
            matches!(
                n.spec,
                NodeSpec::Http {
                    method: HttpMethod::Get,
                    ..
                }
            )
        })
        .map(|n| &n.id)
        .collect();
    loop {
        let before = tainted.len();
        for node in &graph.nodes {
            if refs[&node.id].iter().any(|r| tainted.contains(r)) {
                tainted.insert(&node.id);
            }
        }
        if tainted.len() == before {
            break;
        }
    }
    graph.nodes.iter().any(|agent| {
        matches!(agent.spec, NodeSpec::Agent { .. })
            && refs[&agent.id].iter().any(|r| tainted.contains(r))
            && descendants(graph, &agent.id).iter().any(|d| {
                graph
                    .node(d)
                    .is_some_and(|n| n.spec.kind() == NodeKind::Http)
            })
    })
}

fn references(spec: &NodeSpec) -> Vec<Reference> {
    spec.templates()
        .into_iter()
        .filter_map(|(_, t)| template::parse(t.as_str()).ok())
        .flat_map(|p| p.references().cloned().collect::<Vec<_>>())
        .collect()
}

fn referenced_nodes(spec: &NodeSpec) -> Vec<NodeId> {
    references(spec)
        .into_iter()
        .filter_map(|r| match r {
            Reference::NodeOutput { node, .. } => Some(node),
            _ => None,
        })
        .collect()
}

/// Secret names an http node reads, sorted and unique.
pub fn secret_names(spec: &NodeSpec) -> Vec<String> {
    let mut names: Vec<String> = references(spec)
        .into_iter()
        .filter_map(|r| match r {
            Reference::Secret(name) => Some(name),
            _ => None,
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Kahn order over nodes, ties broken by declaration order. `None` on a cycle.
pub fn topo_order(graph: &Graph) -> Option<Vec<NodeId>> {
    let adjacency = children(graph);
    let mut indegree: HashMap<&NodeId, usize> = graph.nodes.iter().map(|n| (&n.id, 0)).collect();
    for tos in adjacency.values() {
        for to in tos {
            *indegree.get_mut(to)? += 1;
        }
    }
    let mut order = Vec::with_capacity(graph.nodes.len());
    let mut done: HashSet<&NodeId> = HashSet::new();
    while order.len() < graph.nodes.len() {
        let next = graph
            .nodes
            .iter()
            .map(|n| &n.id)
            .find(|id| !done.contains(id) && indegree[id] == 0)?;
        done.insert(next);
        order.push(next.clone());
        for to in adjacency.get(next).into_iter().flatten() {
            if let Some(d) = indegree.get_mut(to) {
                *d -= 1;
            }
        }
    }
    Some(order)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpError {
    EmptyBatch,
    NodeExists { index: usize, id: NodeId },
    NodeNotFound { index: usize, id: NodeId },
    EdgeExists { index: usize },
    EdgeNotFound { index: usize },
    EmptyName { index: usize },
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpError::EmptyBatch => f.write_str("the op batch is empty"),
            OpError::NodeExists { index, id } => write!(f, "op {index}: node {id} already exists"),
            OpError::NodeNotFound { index, id } => {
                write!(f, "op {index}: node {id} does not exist")
            }
            OpError::EdgeExists { index } => write!(f, "op {index}: that edge already exists"),
            OpError::EdgeNotFound { index } => write!(f, "op {index}: that edge does not exist"),
            OpError::EmptyName { index } => write!(f, "op {index}: name must not be empty"),
        }
    }
}

impl std::error::Error for OpError {}

/// Applies the whole batch or nothing, bumping `revision` once. Structural
/// problems are left for [`validate`]; only ops that cannot apply fail here.
pub fn apply_ops(automation: &Automation, ops: &[Op]) -> Result<Automation, OpError> {
    if ops.is_empty() {
        return Err(OpError::EmptyBatch);
    }
    let mut next = automation.clone();
    for (index, op) in ops.iter().enumerate() {
        apply_one(&mut next, index, op)?;
    }
    next.revision += 1;
    Ok(next)
}

fn apply_one(a: &mut Automation, index: usize, op: &Op) -> Result<(), OpError> {
    let graph = &mut a.graph;
    let position = |graph: &Graph, id: &NodeId| {
        graph
            .nodes
            .iter()
            .position(|n| &n.id == id)
            .ok_or_else(|| OpError::NodeNotFound {
                index,
                id: id.clone(),
            })
    };
    match op {
        Op::AddNode { node } => {
            if graph.node(&node.id).is_some() {
                return Err(OpError::NodeExists {
                    index,
                    id: node.id.clone(),
                });
            }
            graph.nodes.push(node.clone());
        }
        Op::UpdateNode { id, label, spec } => {
            let i = position(graph, id)?;
            if let Some(label) = label {
                graph.nodes[i].label = label.clone();
            }
            if let Some(spec) = spec {
                graph.nodes[i].spec = spec.clone();
            }
        }
        Op::RemoveNode { id } => {
            let i = position(graph, id)?;
            graph.nodes.remove(i);
            graph
                .edges
                .retain(|e| &e.to != id && e.from != EdgeSource::Node(id.clone()));
        }
        Op::Connect { edge } => {
            if graph.edges.contains(edge) {
                return Err(OpError::EdgeExists { index });
            }
            graph.edges.push(edge.clone());
        }
        Op::Disconnect { edge } => {
            let i = graph
                .edges
                .iter()
                .position(|e| e == edge)
                .ok_or(OpError::EdgeNotFound { index })?;
            graph.edges.remove(i);
        }
        Op::SetTrigger { trigger } => a.trigger = trigger.clone(),
        Op::Rename { name } => {
            if name.trim().is_empty() {
                return Err(OpError::EmptyName { index });
            }
            a.name = name.clone();
        }
        Op::SetIsolation { isolation } => a.isolation = *isolation,
    }
    Ok(())
}
