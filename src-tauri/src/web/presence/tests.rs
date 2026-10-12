use super::*;

fn identity(device_id: &str, instance: &str) -> ClientIdentity {
    ClientIdentity {
        device_id: device_id.to_string(),
        client_instance_id: instance.to_string(),
    }
}

#[test]
fn aggregates_connections_of_one_device_across_tabs_and_carriers() {
    let registry = Arc::new(PresenceRegistry::new());
    assert_eq!(registry.device("phone"), None);

    let ws_tab1 = registry.register(&identity("phone", "tab-1"), Carrier::Ws);
    let terminal_tab1 = registry.register(&identity("phone", "tab-1"), Carrier::TerminalWs);
    let ws_tab2 = registry.register(&identity("phone", "tab-2"), Carrier::Ws);
    let _laptop = registry.register(&identity("laptop", "tab-1"), Carrier::Ws);

    let phone = registry.device("phone").expect("phone is present");
    assert_eq!(phone.connections, 3);
    assert_eq!(
        phone.client_instances,
        BTreeSet::from(["tab-1".to_string(), "tab-2".to_string()])
    );
    assert_eq!(phone.carriers, BTreeSet::from(["ws", "terminal_ws"]));
    assert_eq!(registry.device_count(), 2);

    // Dropping one of several connections keeps the device present, and the
    // aggregate shrinks with it.
    drop(ws_tab2);
    let phone = registry.device("phone").expect("still present");
    assert_eq!(phone.connections, 2);
    assert_eq!(phone.client_instances, BTreeSet::from(["tab-1".to_string()]));

    drop(terminal_tab1);
    assert_eq!(registry.device("phone").expect("still present").carriers, BTreeSet::from(["ws"]));

    // The last connection removes the device; the other device is untouched.
    drop(ws_tab1);
    assert_eq!(registry.device("phone"), None);
    assert_eq!(registry.device("laptop").expect("laptop stays").connections, 1);
    assert_eq!(registry.device_count(), 1);
}

#[test]
fn identical_identities_register_independent_connections() {
    // A reconnect can briefly overlap its predecessor with the same
    // (deviceId, clientInstanceId): each connection is its own entry and the
    // older guard dropping must not evict the newer connection.
    let registry = Arc::new(PresenceRegistry::new());
    let old = registry.register(&identity("phone", "tab-1"), Carrier::Ws);
    let new = registry.register(&identity("phone", "tab-1"), Carrier::Ws);
    assert_eq!(registry.device("phone").expect("present").connections, 2);
    drop(old);
    assert_eq!(registry.device("phone").expect("present").connections, 1);
    drop(new);
    assert_eq!(registry.device("phone"), None);
}
