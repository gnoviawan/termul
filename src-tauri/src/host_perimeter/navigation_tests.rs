use tauri::Url;

use super::navigation::{tab_navigation_denial, TabNavDenial};

const OWNED: u16 = 47_001;
const DEV_URL: &str = "http://localhost:5180/tauri-index.html";

fn denial(raw: &str) -> Option<TabNavDenial> {
    let dev = Url::parse(DEV_URL).unwrap();
    tab_navigation_denial(&Url::parse(raw).unwrap(), |port| port == OWNED, Some(&dev))
}

#[test]
fn ordinary_sites_and_third_party_loopback_ports_are_allowed() {
    for raw in [
        "https://example.com/",
        "http://localhost:3000/",
        "http://127.0.0.1:8080/app?x=1",
        "http://[::1]:4000/",
        "http://192.168.1.10/",
        "http://myapp.localhost:5173/",
        "about:blank",
        "data:text/html,hi",
    ] {
        assert_eq!(denial(raw), None, "{raw}");
    }
}

#[test]
fn app_protocol_ipc_and_asset_origins_are_denied() {
    for raw in [
        "tauri://localhost/",
        "http://tauri.localhost/",
        "https://tauri.localhost/index.html",
        "http://ipc.localhost/cmd",
        "ipc://localhost/cmd",
        "asset://localhost/file",
        "http://asset.localhost/file",
        "http://TAURI.LOCALHOST./",
    ] {
        assert_eq!(denial(raw), Some(TabNavDenial::AppOrigin), "{raw}");
    }
}

#[test]
fn dev_server_origin_is_denied_under_any_loopback_name() {
    for raw in [
        "http://localhost:5180/",
        "http://localhost:5180/tauri-index.html#x",
        "http://127.0.0.1:5180/",
        "http://[::1]:5180/",
    ] {
        assert_eq!(denial(raw), Some(TabNavDenial::AppOrigin), "{raw}");
    }
}

#[test]
fn dev_origin_is_not_special_outside_dev_builds() {
    let url = Url::parse("http://localhost:5180/").unwrap();
    assert_eq!(tab_navigation_denial(&url, |_| false, None), None);
}

#[test]
fn owned_ports_are_denied_on_every_loopback_spelling() {
    for raw in [
        "http://127.0.0.1:47001/",
        "http://localhost:47001/health",
        "http://127.0.0.2:47001/",
        "http://127.1:47001/",
        "http://2130706433:47001/",
        "http://[::1]:47001/",
        "http://[::ffff:127.0.0.1]:47001/",
    ] {
        assert_eq!(denial(raw), Some(TabNavDenial::OwnedPort(OWNED)), "{raw}");
    }
}

#[test]
fn owned_port_on_a_public_host_is_allowed() {
    assert_eq!(denial("https://example.com:47001/"), None);
}

#[test]
fn unspecified_addresses_are_denied() {
    for raw in [
        "http://0.0.0.0:3000/",
        "http://0:3000/",
        "http://[::]:3000/",
        "http://[::ffff:0.0.0.0]/",
    ] {
        assert_eq!(denial(raw), Some(TabNavDenial::UnspecifiedAddress), "{raw}");
    }
}

#[test]
fn link_local_and_metadata_endpoints_are_denied() {
    for raw in [
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.1.1/",
        "http://[fe80::1]/",
        "http://[fd00:ec2::254]/",
        "http://[::ffff:169.254.169.254]/",
        "http://metadata.google.internal/computeMetadata/v1/",
    ] {
        assert_eq!(
            denial(raw),
            Some(TabNavDenial::LinkLocalOrMetadata),
            "{raw}"
        );
    }
}

#[test]
fn denial_reasons_are_stable_log_codes() {
    assert_eq!(TabNavDenial::AppOrigin.reason(), "app_origin");
    assert_eq!(TabNavDenial::OwnedPort(1).reason(), "owned_port");
    assert_eq!(
        TabNavDenial::UnspecifiedAddress.reason(),
        "unspecified_address"
    );
    assert_eq!(
        TabNavDenial::LinkLocalOrMetadata.reason(),
        "link_local_or_metadata"
    );
}
