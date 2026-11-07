use super::*;

#[test]
fn capability_ids_are_the_closed_snake_case_set() {
    let names: Vec<serde_json::Value> = CapabilityId::ALL
        .iter()
        .map(|id| serde_json::to_value(id).unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "isolated_eval",
            "script_message",
            "persistent_profile",
            "navigation_intercept",
            "new_window_intercept",
            "dialog_intercept",
            "file_chooser",
            "download_intercept",
            "permission_intercept",
            "external_protocol_intercept",
            "screenshot",
            "pointer_click",
            "trusted_key",
            "pointer_move",
            "wheel",
            "drag",
            "console_observe",
            "network_observe",
        ]
    );
    for id in CapabilityId::ALL {
        assert_eq!(serde_json::to_value(id).unwrap(), serde_json::json!(id.as_str()));
    }
}

#[test]
fn capability_table_raises_only_the_named_tiers() {
    let table = CapabilityTable::unavailable("nope").with(CapabilityId::Screenshot, Support::Trusted);
    assert_eq!(table.get(CapabilityId::Screenshot), Support::Trusted);
    for id in CapabilityId::ALL
        .into_iter()
        .filter(|id| *id != CapabilityId::Screenshot)
    {
        assert_eq!(table.get(id), Support::Unavailable("nope"), "{id:?}");
    }
}

#[cfg(target_os = "windows")]
#[test]
fn webview2_declares_isolated_eval_trusted_click_screenshot_file_inputs_and_policy_hooks_and_synthetic_dom_events() {
    let table = webview2::capability_table();
    assert_eq!(table.get(CapabilityId::IsolatedEval), Support::Trusted);
    assert_eq!(table.get(CapabilityId::PersistentProfile), Support::Trusted);
    assert_eq!(table.get(CapabilityId::PointerClick), Support::Trusted);
    assert_eq!(table.get(CapabilityId::Screenshot), Support::Trusted);
    assert_eq!(table.get(CapabilityId::FileChooser), Support::Trusted);
    for id in [CapabilityId::TrustedKey, CapabilityId::PointerMove, CapabilityId::Wheel] {
        assert_eq!(table.get(id), Support::Synthetic, "{id:?}");
    }
    for id in [
        CapabilityId::NavigationIntercept,
        CapabilityId::NewWindowIntercept,
        CapabilityId::DialogIntercept,
        CapabilityId::PermissionIntercept,
        CapabilityId::ExternalProtocolIntercept,
        CapabilityId::DownloadIntercept,
    ] {
        assert_eq!(table.get(id), Support::Trusted, "{id:?}");
    }
}
