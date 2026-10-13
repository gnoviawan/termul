//! The desktop's plugin-store import over the two carriers: only a device that
//! reaches the store over the desktop Channel takes it over; a `/ws` device of
//! the same host (shared-live) never does, and a failed import is never hidden
//! behind an empty store.

use crate::web::store::{desktop_legacy_file, StorePolicy, WebStore};

use super::wire::{request, ChannelPeer, Wire};
use super::*;

fn wrapped(data: Value) -> Value {
    json!({ "_version": 1, "data": data })
}

struct Fixture {
    dir: std::path::PathBuf,
    file: std::path::PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "termul-harness-desktop-import-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let file = dir.join("store.json");
        std::fs::write(
            desktop_legacy_file(&dir),
            serde_json::to_vec(&json!({
                "settings/app": wrapped(json!({ "theme": "dark" })),
                "shell-layout": wrapped(json!({ "columns": 3 })),
                "editor-state/p1": wrapped(json!({ "tabs": ["a.ts"] })),
            }))
            .unwrap(),
        )
        .expect("write the plugin-store file");
        Self { dir, file }
    }

    fn legacy(&self) -> std::path::PathBuf {
        desktop_legacy_file(&self.dir)
    }

    /// A host whose ONE store (as on the desktop) serves `/ws` and the Channel.
    fn host(&self) -> Host {
        let store = WebStore::open(
            self.file.clone(),
            StorePolicy {
                partition_gc_age_secs: u64::MAX,
                ..StorePolicy::default()
            },
        )
        .expect("open store")
        .with_desktop_legacy(self.legacy());
        Host::new(|_, _| {}).with_store(Arc::new(store))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn authenticate_as_payload(device: &str, tab: &str) -> Value {
    json!({
        "protocolVersion": WS_PROTOCOL_VERSION,
        "deviceId": device,
        "clientInstanceId": tab,
    })
}

async fn channel_device(host: &Host, device: &str) -> ChannelPeer {
    let mut wire = ChannelPeer::open(host);
    let reply = request(
        &mut wire,
        "auth",
        "authenticate",
        authenticate_as_payload(device, "tab"),
    )
    .await;
    assert_eq!(reply["ok"], true, "handshake refused: {reply}");
    wire
}

async fn read_value<W: Wire>(wire: &mut W, key: &str) -> Value {
    let reply = request(wire, "r", "store_read", json!({ "key": key })).await;
    assert_eq!(reply["ok"], true, "{reply}");
    reply["payload"]["value"].clone()
}

#[tokio::test]
async fn the_first_desktop_carrier_device_adopts_the_import_and_a_ws_device_does_not() {
    let fx = Fixture::new("carriers");
    let host = fx.host();

    // A `/ws` device (shared-live phone) reaches the store first: nothing moves.
    let mut phone = host.connect();
    phone.authenticate_as("phone", "tab-p").await;
    let reply = phone
        .request(
            "r1",
            "store_read",
            json!({ "key": "device/phone/shell-layout" }),
        )
        .await;
    assert_eq!(reply["payload"]["value"], Value::Null, "{reply}");
    let reply = phone
        .request(
            "r2",
            "store_read",
            json!({ "key": "shared/lww/settings/app" }),
        )
        .await;
    assert_eq!(reply["payload"]["value"], Value::Null, "{reply}");
    assert!(
        fx.legacy().exists(),
        "a ws device never takes the plugin-store file"
    );

    // The desktop device's first request over the Channel imports it.
    let mut desktop = channel_device(&host, "desktop").await;
    assert_eq!(
        read_value(&mut desktop, "device/desktop/shell-layout").await,
        wrapped(json!({ "columns": 3 }))
    );
    assert_eq!(
        read_value(&mut desktop, "device/desktop/workspace/p1").await,
        wrapped(json!({ "tabs": ["a.ts"] })),
        "editor-state is renamed to workspace"
    );
    assert!(
        !fx.legacy().exists(),
        "the file is renamed once it is imported"
    );

    // Shared keys are shared: the phone sees the imported settings over `/ws`.
    let reply = phone
        .request(
            "r3",
            "store_read",
            json!({ "key": "shared/lww/settings/app" }),
        )
        .await;
    assert_eq!(
        reply["payload"]["value"],
        wrapped(json!({ "theme": "dark" })),
        "{reply}"
    );
    // Its own partition stays empty.
    let reply = phone
        .request(
            "r4",
            "store_read",
            json!({ "key": "device/phone/shell-layout" }),
        )
        .await;
    assert_eq!(reply["payload"]["value"], Value::Null, "{reply}");

    // A second desktop device (another window profile) imports nothing.
    let mut other = channel_device(&host, "desktop-2").await;
    assert_eq!(
        read_value(&mut other, "device/desktop-2/shell-layout").await,
        Value::Null
    );
}

#[tokio::test]
async fn a_write_as_the_first_desktop_request_imports_before_it_lands() {
    let fx = Fixture::new("first-write");
    let host = fx.host();
    let mut desktop = channel_device(&host, "desktop").await;

    let reply = request(
        &mut desktop,
        "w1",
        "store_write",
        json!({ "key": "device/desktop/window-state", "value": wrapped(json!({ "width": 800 })) }),
    )
    .await;
    assert_eq!(reply["ok"], true, "{reply}");

    assert_eq!(
        read_value(&mut desktop, "device/desktop/shell-layout").await,
        wrapped(json!({ "columns": 3 }))
    );
    assert_eq!(
        read_value(&mut desktop, "device/desktop/window-state").await,
        wrapped(json!({ "width": 800 }))
    );
}

/// A device never sees a store that is missing keys about to be imported: when
/// the import cannot be written the request fails, and the next one retries.
#[tokio::test]
async fn a_failed_import_fails_the_request_and_the_next_request_retries() {
    let fx = Fixture::new("retry");
    let host = fx.host();
    let mut desktop = channel_device(&host, "desktop").await;
    // A directory where the store file goes makes the write fail.
    std::fs::create_dir_all(&fx.file).unwrap();

    let reply = request(
        &mut desktop,
        "r1",
        "store_read",
        json!({ "key": "device/desktop/shell-layout" }),
    )
    .await;
    assert_eq!(reply["ok"], false, "{reply}");
    assert_eq!(reply["err"]["code"], "STORE_UNAVAILABLE", "{reply}");
    assert!(fx.legacy().exists(), "the file stays for the retry");

    std::fs::remove_dir_all(&fx.file).unwrap();
    assert_eq!(
        read_value(&mut desktop, "device/desktop/shell-layout").await,
        wrapped(json!({ "columns": 3 }))
    );
    assert!(!fx.legacy().exists());
}
