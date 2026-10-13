use super::*;

fn request(
    forward_type: &str,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> PortForwardRequest {
    PortForwardRequest {
        id: "f1".into(),
        forward_type: forward_type.into(),
        local_port,
        remote_host: remote_host.into(),
        remote_port,
        label: None,
    }
}

#[test]
fn validate_accepts_local_forwards_only() {
    assert!(validate(&request("local", 8080, "localhost", 80)).is_ok());
    assert!(validate(&request("remote", 8080, "localhost", 80)).is_err());
    assert!(validate(&request("dynamic", 8080, "localhost", 80)).is_err());
}

#[test]
fn validate_rejects_zero_ports_and_empty_hosts() {
    assert!(validate(&request("local", 0, "localhost", 80)).is_err());
    assert!(validate(&request("local", 8080, "localhost", 0)).is_err());
    assert!(validate(&request("local", 8080, "  ", 80)).is_err());
}

#[test]
fn stopping_unknown_forwards_reports_an_error() {
    let manager = PortForwardManager::new(Arc::new(|_, _| {}));
    assert!(manager.stop_forward("s1", "missing").is_err());
    // Bulk stops are no-ops without forwards.
    manager.stop_all_for_session("s1");
    manager.stop_all();
}
