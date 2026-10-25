use super::subagents::{dispatch_id_for, SubagentRoutes};
use super::DriverState;

#[test]
fn a_child_routes_to_its_chat_and_its_own_dispatch() {
    let mut routes = SubagentRoutes::default();
    let route = routes.register("chat-1", "agent-a").expect("route");
    assert_eq!(route.root_session_id, "chat-1");
    assert_eq!(route.dispatch_id, dispatch_id_for("agent-a"));
    assert_eq!(route.parent_dispatch_id, None);
    assert_eq!(routes.root_of("agent-a"), "chat-1");
    assert_eq!(routes.root_of("chat-1"), "chat-1");
}

#[test]
fn a_nested_child_routes_to_the_root_chat_under_its_parent_dispatch() {
    let mut routes = SubagentRoutes::default();
    routes.register("chat-1", "agent-a");
    let nested = routes.register("agent-a", "agent-b").expect("nested route");
    assert_eq!(nested.root_session_id, "chat-1");
    assert_eq!(
        nested.parent_dispatch_id.as_deref(),
        Some(dispatch_id_for("agent-a").as_str())
    );
}

#[test]
fn re_registering_keeps_the_first_route_and_self_parents_are_rejected() {
    let mut routes = SubagentRoutes::default();
    routes.register("chat-1", "agent-a");
    let again = routes
        .register("chat-2", "agent-a")
        .expect("existing route");
    assert_eq!(again.root_session_id, "chat-1");
    assert!(routes.register("agent-x", "agent-x").is_none());
    assert!(routes.register("chat-1", "").is_none());
}

#[test]
fn closing_the_chat_forgets_its_children_only() {
    let mut state = DriverState::default();
    state.register_subagent("chat-1", "agent-a");
    state.register_subagent("agent-a", "agent-b");
    state.register_subagent("chat-2", "agent-c");
    state.remove_session_root("chat-1");
    assert!(state.subagent_route("agent-a").is_none());
    assert!(state.subagent_route("agent-b").is_none());
    assert_eq!(state.chat_session_for("agent-c"), "chat-2");
}

#[test]
fn an_ended_child_keeps_its_route() {
    let mut state = DriverState::default();
    state.register_subagent("chat-1", "agent-a");
    let ended = state.end_subagent("agent-a").expect("ended route");
    assert!(ended.ended);
    assert_eq!(state.chat_session_for("agent-a"), "chat-1");
    assert!(state.end_subagent("unknown").is_none());
}

#[test]
fn a_full_table_evicts_an_ended_route_first() {
    let mut routes = SubagentRoutes::default();
    for i in 0..1024 {
        routes.register("chat-1", &format!("agent-{i}"));
    }
    routes.mark_ended("agent-7");
    routes.register("chat-1", "agent-new");
    assert_eq!(routes.len(), 1024);
    assert!(routes.route("agent-7").is_none());
    assert!(routes.route("agent-0").is_some());
    assert!(routes.route("agent-new").is_some());
}
