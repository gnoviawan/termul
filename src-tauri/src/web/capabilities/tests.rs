use super::*;
use serde_json::json;

fn peer(ip: [u8; 4]) -> SocketAddr {
    SocketAddr::from((ip, 40000))
}

fn flags(allow_remote_writes: bool, shared_live_writes_denied: bool) -> WriteFlags {
    WriteFlags {
        allow_remote_writes,
        shared_live_writes_denied,
    }
}

fn identity(device_id: &str) -> ClientIdentity {
    ClientIdentity {
        device_id: device_id.to_string(),
        client_instance_id: "tab-1".to_string(),
    }
}

const VIEW_ONLY: Capabilities = Capabilities::none(Carrier::Ws);
const WRITER: Capabilities = Capabilities {
    carrier: Carrier::Ws,
    write: true,
};

#[test]
fn write_decision_matrix() {
    let local = peer([127, 0, 0, 1]);
    let lan = peer([192, 168, 1, 50]);
    assert_eq!(write_decision(local, flags(false, false)), WriteDecision::Allowed);
    assert_eq!(
        write_decision(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 1)), flags(false, false)),
        WriteDecision::Allowed,
        "IPv6 loopback is local"
    );
    assert_eq!(
        write_decision(lan, flags(false, false)),
        WriteDecision::DeniedRemotePeer
    );
    assert_eq!(
        write_decision(lan, flags(true, false)),
        WriteDecision::AdmittedByOptIn
    );
    // Shared-live denies before the peer is evaluated, opt-in or not.
    assert_eq!(
        write_decision(local, flags(false, true)),
        WriteDecision::DeniedSharedLive
    );
    assert_eq!(
        write_decision(lan, flags(true, true)),
        WriteDecision::DeniedSharedLive
    );
}

#[test]
fn capabilities_follow_the_write_decision() {
    let lan = peer([10, 0, 0, 9]);
    assert!(Capabilities::resolve(Carrier::Ws, peer([127, 0, 0, 1]), flags(false, false)).write);
    assert!(!Capabilities::resolve(Carrier::Ws, lan, flags(false, false)).write);
    assert!(Capabilities::resolve(Carrier::TerminalWs, lan, flags(true, false)).write);
    let shared_live = Capabilities::resolve(Carrier::TerminalWs, peer([127, 0, 0, 1]), flags(true, true));
    assert!(!shared_live.write);
    assert_eq!(shared_live.carrier, Carrier::TerminalWs);
}

#[test]
fn view_only_may_read_but_not_mutate() {
    let id = identity("device-a");
    for read in [
        "authenticate",
        "ping",
        "subscribe",
        "watch_project",
        "unwatch_project",
        "watch",
        "unwatch",
        "list_persisted_sessions",
        "open_persisted_session",
        "get_session_payload",
        "get_session_payload_tail",
        "recover_session_snapshot",
        "get_session_cursor",
        "list_sessions",
        "list_agents",
        "list_acp_catalog",
        "store_read",
    ] {
        assert!(
            ws_request_permitted(read, &json!({}), VIEW_ONLY, Some(&id)),
            "{read} must stay available to a view-only connection"
        );
    }
    for mutation in [
        "spawn_agent",
        "kill_agent",
        "create_session",
        "load_session",
        "resume_session",
        "close_session",
        "dispose_ephemeral_session",
        "promote_session",
        "register_discovered_session",
        "delete_session",
        "send_prompt",
        "cancel_prompt",
        "set_mode",
        "set_model",
        "set_config_option",
        "respond_permission",
        "answer_question",
        "add_project",
        "update_project",
        "remove_project",
        "set_default_project",
        "switch_project",
        "set_catalog_opt_in",
        "install_acp_agent",
        "authenticate_agent",
        "logout_agent",
        "delete_agent_session",
        "respond_elicitation",
        "acp_deliver_auth_redirect",
        "record_agent_switch",
        // Unknown types are guarded by default.
        "some_future_mutation",
    ] {
        assert!(
            !ws_request_permitted(mutation, &json!({}), VIEW_ONLY, Some(&id)),
            "{mutation} must be refused for a view-only connection"
        );
        assert!(
            ws_request_permitted(mutation, &json!({}), WRITER, Some(&id)),
            "{mutation} must be allowed for a write-capable connection"
        );
    }
}

#[test]
fn view_only_store_writes_are_confined_to_the_device_namespace() {
    let id = identity("device-a");
    for kind in ["store_write", "store_delete"] {
        let allowed = |key: &str| {
            ws_request_permitted(kind, &json!({ "key": key }), VIEW_ONLY, Some(&id))
        };
        assert!(allowed("device/device-a/layout"));
        assert!(allowed("device/device-a/nested/key"));
        assert!(!allowed("device/device-b/layout"), "another device's namespace");
        assert!(!allowed("device/device-a"), "the bare prefix is not a key");
        assert!(!allowed("device/device-a/"), "an empty suffix is not a key");
        assert!(!allowed("device/device-ab/x"), "prefix must end at a path segment");
        assert!(!allowed("settings/theme"), "a global key");
        assert!(!allowed("../device/device-a/x"));
        // A payload without a string key, or a connection without identity.
        assert!(!ws_request_permitted(kind, &json!({}), VIEW_ONLY, Some(&id)));
        assert!(!ws_request_permitted(
            kind,
            &json!({ "key": "device/device-a/x" }),
            VIEW_ONLY,
            None
        ));
        // A writer is unrestricted.
        assert!(ws_request_permitted(
            kind,
            &json!({ "key": "settings/theme" }),
            WRITER,
            Some(&id)
        ));
    }
}

#[test]
fn a_device_id_containing_a_slash_gets_no_private_namespace() {
    // `device/a/b/x` would belong to device `a/b` AND be reachable by device `a`.
    assert_eq!(device_store_prefix("a/b"), None);
    assert_eq!(device_store_prefix("a"), Some("device/a/".to_string()));
    let slashed = identity("a/b");
    assert!(!ws_request_permitted(
        "store_write",
        &json!({ "key": "device/a/b/x" }),
        VIEW_ONLY,
        Some(&slashed)
    ));
}

#[test]
fn terminal_view_allow_list_excludes_every_mutation() {
    for view in [
        "authenticate",
        "attach",
        "detach",
        "get_cwd",
        "get_git_branch",
        "get_git_status",
        "get_exit_code",
    ] {
        assert!(terminal_request_is_view(view), "{view}");
    }
    for mutation in [
        "spawn",
        "write",
        "resize",
        "kill",
        "rotate_claim",
        "revoke_claim",
        "set_protected",
        "update_orphan_detection",
        "add_renderer_ref",
        "remove_renderer_ref",
        // Re-issues the claim of every unattached terminal.
        "list_preserved",
    ] {
        assert!(!terminal_request_is_view(mutation), "{mutation}");
    }
}
