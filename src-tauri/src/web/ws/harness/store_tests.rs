//! The scoped device/shared store over the production relay loop: every
//! host-side row of the #1073 I/O matrix, driven through real `authenticate`d
//! connections.

use crate::web::store::{unix_ms, Precondition, StorePolicy, WebStore};

use super::*;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

struct Fixture {
    dir: std::path::PathBuf,
    file: std::path::PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "termul-harness-store-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create fixture dir");
        let file = dir.join("store.json");
        Self { dir, file }
    }

    fn store(&self, policy: StorePolicy) -> Arc<WebStore> {
        Arc::new(WebStore::open(self.file.clone(), policy).expect("open store"))
    }

    fn host(&self) -> (Host, Arc<WebStore>) {
        let store = self.store(StorePolicy::default());
        (Host::new(|_, _| {}).with_store(Arc::clone(&store)), store)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn connect_as(host: &Host, device: &str, tab: &str) -> Conn {
    let mut conn = host.connect();
    conn.authenticate_as(device, tab).await;
    conn
}

fn code(reply: &Value) -> &str {
    reply["err"]["code"].as_str().unwrap_or("")
}

async fn write(conn: &mut Conn, key: &str, value: Value, extra: Value) -> Value {
    let mut payload = json!({ "key": key, "value": value });
    for (field, value) in extra.as_object().into_iter().flatten() {
        payload[field] = value.clone();
    }
    conn.request("w", "store_write", payload).await
}

async fn read(conn: &mut Conn, key: &str) -> Value {
    conn.request("r", "store_read", json!({ "key": key })).await
}

#[tokio::test]
async fn each_device_reads_only_its_own_layout_and_cannot_name_anothers() {
    let fx = Fixture::new("isolation");
    let (host, _store) = fx.host();
    let mut desktop = connect_as(&host, "desktop", "tab-d").await;
    let mut phone = connect_as(&host, "phone", "tab-p").await;

    assert_eq!(write(&mut desktop, "device/desktop/shell-layout", json!("wide"), json!({})).await["ok"], true);
    assert_eq!(write(&mut phone, "device/phone/shell-layout", json!("narrow"), json!({})).await["ok"], true);

    let own = read(&mut desktop, "device/desktop/shell-layout").await;
    assert_eq!(own["payload"]["value"], json!("wide"));
    let own = read(&mut phone, "device/phone/shell-layout").await;
    assert_eq!(own["payload"]["value"], json!("narrow"));

    for reply in [
        read(&mut phone, "device/desktop/shell-layout").await,
        write(&mut phone, "device/desktop/shell-layout", json!("x"), json!({})).await,
        phone
            .request("d", "store_delete", json!({ "key": "device/desktop/shell-layout" }))
            .await,
    ] {
        assert_eq!(reply["ok"], false, "{reply}");
        assert_eq!(code(&reply), "STORE_KEY_SCOPE", "{reply}");
    }
    assert_eq!(read(&mut desktop, "device/desktop/shell-layout").await["payload"]["value"], json!("wide"));
}

#[tokio::test]
async fn an_unscoped_key_never_reaches_the_store() {
    let fx = Fixture::new("unscoped");
    let (host, _store) = fx.host();
    let mut conn = connect_as(&host, "dev", "tab").await;
    for key in ["shell-layout", "host/lastSeen", "legacy/shell-layout"] {
        assert_eq!(code(&read(&mut conn, key).await), "STORE_KEY_SCOPE", "{key}");
        assert_eq!(code(&write(&mut conn, key, json!(1), json!({})).await), "STORE_KEY_SCOPE", "{key}");
    }
    assert!(!fx.file.exists(), "refusals never write the file");
}

#[tokio::test]
async fn two_tabs_of_one_device_converge_on_the_last_arrival() {
    let fx = Fixture::new("two-tabs");
    let (host, _store) = fx.host();
    let mut tab1 = connect_as(&host, "dev", "tab-1").await;
    let mut tab2 = connect_as(&host, "dev", "tab-2").await;
    write(&mut tab1, "device/dev/shell-layout", json!("one"), json!({})).await;
    let second = write(&mut tab2, "device/dev/shell-layout", json!("two"), json!({})).await;
    assert_eq!(second["payload"]["revision"], json!(2));
    for tab in [&mut tab1, &mut tab2] {
        let reply = read(tab, "device/dev/shell-layout").await;
        assert_eq!(reply["payload"]["value"], json!("two"));
        assert_eq!(reply["payload"]["revision"], json!(2));
        assert_eq!(reply["payload"]["clientInstanceId"], json!("tab-2"));
    }
}

#[tokio::test]
async fn shared_lww_merges_concurrent_field_edits_and_demands_a_base() {
    let fx = Fixture::new("lww");
    let (host, _store) = fx.host();
    let mut a = connect_as(&host, "dev-a", "tab-a").await;
    let mut b = connect_as(&host, "dev-b", "tab-b").await;
    let key = "shared/lww/settings/app";
    let wrap = |data: Value| json!({ "_version": 1, "data": data });

    let first = write(&mut a, key, wrap(json!({ "f1": 0, "f2": 0 })), json!({})).await;
    assert_eq!(first["payload"]["revision"], json!(1), "{first}");

    // Write before read: the key exists and the write names no base.
    let refused = write(&mut b, key, wrap(json!({ "f1": 0, "f2": "B" })), json!({})).await;
    assert_eq!(code(&refused), "STORE_BASE_REQUIRED", "{refused}");

    // Both read revision 1; A sets f1, B sets f2.
    let seen = read(&mut b, key).await;
    let base = seen["payload"]["revision"].clone();
    write(&mut a, key, wrap(json!({ "f1": "A", "f2": 0 })), json!({ "baseRevision": 1 })).await;
    let merged = write(&mut b, key, wrap(json!({ "f1": 0, "f2": "B" })), json!({ "baseRevision": base })).await;
    assert_eq!(merged["ok"], true, "{merged}");
    assert_eq!(merged["payload"]["value"], wrap(json!({ "f1": "A", "f2": "B" })));
    assert_eq!(merged["payload"]["revision"], json!(3));
    assert_eq!(merged["payload"]["merged"], json!(true));
    assert_eq!(read(&mut a, key).await["payload"]["value"], wrap(json!({ "f1": "A", "f2": "B" })));
}

#[tokio::test]
async fn shared_cas_survives_a_lost_reply_and_rejects_a_stale_expected() {
    let fx = Fixture::new("cas");
    let (host, _store) = fx.host();
    let mut a = connect_as(&host, "dev-a", "tab-a").await;
    let mut b = connect_as(&host, "dev-b", "tab-b").await;
    let key = "shared/cas/ssh/profiles";
    let v1 = json!({ "_version": 1, "data": ["p1"] });

    let first = write(&mut a, key, v1.clone(), json!({ "expected": null, "commandId": "cmd-1" })).await;
    assert_eq!(first["ok"], true, "{first}");
    // The reply was lost: the identical write is sent again.
    let resend = write(&mut a, key, v1.clone(), json!({ "expected": null, "commandId": "cmd-1" })).await;
    assert_eq!(resend["ok"], true, "{resend}");
    assert_eq!(resend["payload"], first["payload"]);

    // Another device with a stale `expected` and its own command loses.
    let stale = write(&mut b, key, json!({ "_version": 1, "data": ["p2"] }), json!({ "expected": null, "commandId": "cmd-2" })).await;
    assert_eq!(code(&stale), "STORE_CAS_FAILED", "{stale}");

    // A write without `expected` is malformed, not a blind overwrite.
    let blind = write(&mut b, key, json!(1), json!({ "commandId": "cmd-3" })).await;
    assert_eq!(code(&blind), "VALIDATION_ERROR", "{blind}");
    assert_eq!(read(&mut b, key).await["payload"]["value"], v1);
}

#[tokio::test]
async fn a_partition_past_its_byte_budget_is_refused_and_the_file_untouched() {
    let fx = Fixture::new("budget");
    let store = fx.store(StorePolicy { partition_byte_budget: 800, ..StorePolicy::default() });
    let host = Host::new(|_, _| {}).with_store(store);
    let mut conn = connect_as(&host, "dev", "tab").await;
    assert_eq!(write(&mut conn, "device/dev/k1", json!("x".repeat(500)), json!({})).await["ok"], true);
    let before = std::fs::read(&fx.file).unwrap();
    let full = write(&mut conn, "device/dev/k2", json!("y".repeat(500)), json!({})).await;
    assert_eq!(code(&full), "STORE_PARTITION_FULL", "{full}");
    assert_eq!(std::fs::read(&fx.file).unwrap(), before);
}

#[tokio::test]
async fn an_oversized_value_is_refused_not_dropped() {
    let fx = Fixture::new("oversized");
    let (host, _store) = fx.host();
    let mut conn = connect_as(&host, "dev", "tab").await;
    let reply = write(&mut conn, "device/dev/big", json!("x".repeat(256 * 1024 + 1)), json!({})).await;
    assert_eq!(code(&reply), "STORE_VALUE_TOO_LARGE", "{reply}");
    assert_eq!(read(&mut conn, "device/dev/big").await["payload"]["revision"], json!(0));
}

#[tokio::test]
async fn the_sweep_collects_a_stale_partition_but_never_a_connected_device() {
    let fx = Fixture::new("gc");
    let (host, store) = fx.host();
    let mut live = connect_as(&host, "live", "tab").await;
    write(&mut live, "device/live/k", json!(1), json!({})).await;
    // A device that was last seen a long time ago and is gone.
    let long_ago = unix_ms() - 200 * DAY_MS;
    store
        .write(
            "device/gone/k",
            json!(1),
            Precondition::default(),
            &crate::web::ws::ClientIdentity {
                device_id: "gone".into(),
                client_instance_id: "t".into(),
            },
            long_ago,
        )
        .unwrap();

    let present = host.relay.presence().device_ids();
    assert_eq!(present, std::collections::HashSet::from(["live".to_string()]));
    let collected = store.sweep(unix_ms() + 200 * DAY_MS, &present).unwrap();
    assert_eq!(collected, vec!["gone".to_string()]);
    assert_eq!(read(&mut live, "device/live/k").await["payload"]["value"], json!(1));
}

#[tokio::test]
async fn revisions_survive_a_host_restart() {
    let fx = Fixture::new("restart");
    {
        let (host, _store) = fx.host();
        let mut conn = connect_as(&host, "dev", "tab-1").await;
        write(&mut conn, "device/dev/k", json!(1), json!({})).await;
        write(&mut conn, "device/dev/k", json!(2), json!({})).await;
    }
    let (host, _store) = fx.host();
    let mut conn = connect_as(&host, "dev", "tab-9").await;
    let reply = read(&mut conn, "device/dev/k").await;
    assert_eq!(reply["payload"]["revision"], json!(2));
    assert_eq!(reply["payload"]["clientInstanceId"], json!("tab-1"));
    let next = write(&mut conn, "device/dev/k", json!(3), json!({})).await;
    assert_eq!(next["payload"]["revision"], json!(3), "the watermark never goes backwards");
}

#[tokio::test]
async fn a_v1_store_is_migrated_and_adopted_by_the_first_device_to_connect() {
    let fx = Fixture::new("legacy");
    let v1 = br#"{"schemaVersion":1,"data":{
        "settings/app":{"_version":1,"data":{"theme":"dark"}},
        "shell-layout":{"_version":1,"data":{"cols":3}}}}"#;
    std::fs::write(&fx.file, v1).unwrap();
    let (host, _store) = fx.host();

    let backups: Vec<_> = std::fs::read_dir(&fx.dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("store.json.pre-v2-"))
        .collect();
    assert_eq!(backups.len(), 1, "the original is backed up before migrating");
    assert_eq!(std::fs::read(backups[0].path()).unwrap(), v1);

    let mut first = connect_as(&host, "first", "tab").await;
    let mut second = connect_as(&host, "second", "tab").await;
    // The first device to ask adopts the parked layout; the second gets none.
    let adopted = read(&mut first, "device/first/shell-layout").await;
    assert_eq!(adopted["payload"]["value"], json!({ "_version": 1, "data": { "cols": 3 } }));
    let shared = read(&mut second, "shared/lww/settings/app").await;
    assert_eq!(shared["payload"]["value"], json!({ "_version": 1, "data": { "theme": "dark" } }));
    assert_eq!(read(&mut second, "device/second/shell-layout").await["payload"]["revision"], json!(0));
}

#[tokio::test]
async fn the_first_device_to_connect_adopts_the_retired_workspace_manifests() {
    let fx = Fixture::new("manifests");
    let manifests = fx.dir.join("workspace-manifests");
    std::fs::create_dir_all(&manifests).unwrap();
    std::fs::write(
        manifests.join("p1.json"),
        serde_json::to_vec(&json!({ "schemaVersion": 1, "manifest": {
            "projectId": "p1", "revision": 3, "updatedAt": 77,
            "topology": { "type": "leaf", "id": "pane", "terminalIds": [],
                "editorIds": ["edit-/w/a.ts"], "activeTabId": "edit-/w/a.ts" },
            "activePaneId": "pane",
            "terminals": [],
            "editors": [{ "editorId": "edit-/w/a.ts", "filePath": "/w/a.ts" }]
        }}))
        .unwrap(),
    )
    .unwrap();
    let store = Arc::new(
        WebStore::open(fx.file.clone(), StorePolicy::default())
            .expect("open store")
            .with_legacy_manifests(manifests.clone()),
    );
    let host = Host::new(|_, _| {}).with_store(store);

    let mut first = connect_as(&host, "first", "tab").await;
    let mut second = connect_as(&host, "second", "tab").await;
    let adopted = read(&mut first, "device/first/workspace/p1").await;
    assert_eq!(adopted["ok"], true, "{adopted}");
    let data = &adopted["payload"]["value"]["data"];
    assert_eq!(data["activePaneId"], json!("pane"));
    assert_eq!(data["openFiles"][0]["filePath"], json!("/w/a.ts"));
    assert_eq!(
        data["paneLayout"]["tabs"],
        json!([{ "type": "editor", "filePath": "/w/a.ts" }])
    );
    // The second device finds nothing under its own partition.
    let other = read(&mut second, "device/second/workspace/p1").await;
    assert_eq!(other["payload"]["revision"], json!(0));
    assert_eq!(other["payload"]["value"], Value::Null);
    // The directory moved aside once the adoption was written.
    assert!(!manifests.exists());
}

#[tokio::test]
async fn a_newer_schema_refuses_to_open() {
    let fx = Fixture::new("newer");
    std::fs::write(&fx.file, br#"{"schemaVersion":9,"data":{}}"#).unwrap();
    assert!(WebStore::open(fx.file.clone(), StorePolicy::default()).is_err());
}

#[tokio::test]
async fn an_unreadable_store_surfaces_unavailable_and_never_a_default() {
    let fx = Fixture::new("unavailable");
    // A directory where the file belongs: the open degrades the store.
    std::fs::create_dir_all(&fx.file).unwrap();
    let (host, _store) = fx.host();
    let mut conn = connect_as(&host, "dev", "tab").await;
    let reply = read(&mut conn, "device/dev/shell-layout").await;
    assert_eq!(reply["ok"], false);
    assert_eq!(code(&reply), "STORE_UNAVAILABLE", "{reply}");
    let reply = write(&mut conn, "device/dev/shell-layout", json!(1), json!({})).await;
    assert_eq!(code(&reply), "STORE_UNAVAILABLE", "{reply}");
}
