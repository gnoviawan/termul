use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::browser_automation::core::test_support::{InMemoryPolicyStore, ScriptedPermissions};
use crate::browser_automation::core::tests::{harness_parts, tab_of, webview2_like, FakeEngine, Harness};
use crate::browser_automation::core::HostServices;
use crate::browser_automation::engine::Support;

struct Dirs {
    project: tempfile::TempDir,
    outside: tempfile::TempDir,
}

fn dirs() -> Dirs {
    let d = Dirs {
        project: tempfile::tempdir().unwrap(),
        outside: tempfile::tempdir().unwrap(),
    };
    fs::create_dir_all(d.project.path().join("dist")).unwrap();
    fs::write(d.project.path().join("dist/index.html"), b"<a href=about.html>About</a>").unwrap();
    fs::write(d.project.path().join("dist/about.html"), b"<h1>About</h1>").unwrap();
    fs::write(d.project.path().join(".env"), b"FAKE_TOKEN=not-real").unwrap();
    fs::write(d.outside.path().join("a.html"), b"<p>notes</p>").unwrap();
    d
}

fn file_url(path: &Path) -> String {
    Url::from_file_path(path).expect("absolute path").to_string()
}

fn real_url(path: &Path) -> String {
    file_url(&fs::canonicalize(path).unwrap())
}

fn local_plain(path: &Path) -> std::path::PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => std::path::PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

fn harness(project: &Path) -> (Harness, Arc<ScriptedPermissions>) {
    let root = project.to_path_buf();
    let permissions = Arc::new(ScriptedPermissions::default());
    let services = HostServices {
        permissions: permissions.clone(),
        policy: Arc::new(InMemoryPolicyStore::opening_sites_unasked()),
        project_of: Arc::new(|_| "p1".to_string()),
        root_of: Arc::new(move |_| Some(root.clone())),
    };
    let h = harness_parts(FakeEngine::new(webview2_like()), false, services, Support::Trusted);
    (h, permissions)
}

/// Wait for the off-UI-thread check of a cancelled hop to reach `until`;
/// a check that never gets there fails the test.
async fn settle(h: &Harness, until: impl Fn(&Harness) -> bool) {
    for _ in 0..200 {
        if until(h) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the cancelled link's check never finished");
}

/// Give a check that should do nothing the time to do it anyway.
async fn let_checks_run() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn open_index(h: &Harness, d: &Dirs) -> String {
    let index = d.project.path().join("dist/index.html");
    let reply = h.call_as("s1", "navigate", json!({ "url": file_url(&index) })).await;
    assert_eq!(reply["ok"], true, "{reply}");
    tab_of(&reply)
}

fn about_url(d: &Dirs) -> String {
    file_url(&d.project.path().join("dist/about.html"))
}

fn granted(h: &Harness, url: &str) -> bool {
    h.host.gate.file_read_access("s1", &url.parse().unwrap()).is_some()
}

#[tokio::test]
async fn a_project_link_hop_is_checked_granted_and_loaded_by_its_real_path() {
    let d = dirs();
    let (h, perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = d.project.path().join("dist/about.html");
    // The page's own link, spelled as the page wrote it.
    h.pane.user_navigates(&tab, &file_url(&about));
    let real = real_url(&about);
    settle(&h, |h| h.pane.file_loads.lock().iter().any(|(url, _)| *url == real)).await;
    let loads = h.pane.file_loads.lock().clone();
    assert_eq!(loads.len(), 2, "{loads:?}");
    assert_eq!(loads[1].0, real, "loaded by its real path");
    assert_eq!(loads[1].1, local_plain(&fs::canonicalize(d.project.path()).unwrap()), "reads the project");
    assert!(perms.requests.lock().is_empty(), "no prompt for a project link");
    let page = h.host.registry.lock().get(&tab).map(|r| r.url.clone());
    assert_eq!(page.as_deref(), Some(real.as_str()));
    assert_eq!(
        h.host.gate.check_hop("s1", &real.parse().unwrap()),
        crate::browser_automation::core::authz::HopVerdict::Allow,
        "granted exactly"
    );
    assert!(!granted(&h, &file_url(&d.project.path().join("dist/other.html"))), "and nothing else");
}

#[tokio::test]
async fn an_outside_link_hop_stays_cancelled_and_the_next_reply_says_to_navigate() {
    let d = dirs();
    let (h, perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let note = file_url(&d.outside.path().join("a.html"));
    h.pane.user_navigates(&tab, &note);
    settle(&h, |h| h.host.registry.lock().get(&tab).is_some_and(|r| !r.file_links.is_empty())).await;
    assert_eq!(h.pane.file_loads.lock().len(), 1, "nothing else loaded");
    assert!(perms.requests.lock().is_empty(), "a link never prompts");
    let reply = h.call_as("s1", "list_tabs", json!({})).await;
    assert_eq!(reply["ok"], true, "{reply}");
    let snapshot = h.call_as("s1", "snapshot", json!({})).await;
    let links = &snapshot["page"]["fileLinks"];
    assert_eq!(links[0]["url"], note, "{snapshot}");
    assert_eq!(links[0]["reason"], "outside_project");
    assert!(links[0]["message"].as_str().unwrap().contains("call navigate"));
    assert!(snapshot["data"].get("fileLinks").is_none(), "page-chosen URLs live in page, never data");
    let again = h.call_as("s1", "snapshot", json!({})).await;
    assert!(again["page"].get("fileLinks").is_none(), "reported once");
}

#[tokio::test]
async fn a_link_to_a_secret_is_refused_and_reported() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    h.pane.user_navigates(&tab, &file_url(&d.project.path().join(".env")));
    settle(&h, |h| h.host.registry.lock().get(&tab).is_some_and(|r| !r.file_links.is_empty())).await;
    let snapshot = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(snapshot["page"]["fileLinks"][0]["reason"], "secret_file", "{snapshot}");
    assert_eq!(h.pane.file_loads.lock().len(), 1);
}

#[tokio::test]
async fn a_hop_a_frame_of_the_page_points_at_keeps_its_exact_grant() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = about_url(&d);
    *h.engine.frame_sources.lock() = vec![about.clone()];
    h.pane.user_navigates(&tab, &about);
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1, "an embedded project file is never followed");
    assert!(!granted(&h, &about));
    assert!(h.host.registry.lock().get(&tab).is_some_and(|r| r.file_links.is_empty()), "frames are logged, not reported");
}

#[tokio::test]
async fn a_known_frame_hop_never_takes_the_link_path() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = about_url(&d);
    assert!(!h.pane.events(&tab).frame_starting(&about.parse().unwrap()), "the frame is blocked");
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1);
    assert!(!granted(&h, &about));
}

#[tokio::test]
async fn a_web_page_link_to_a_file_is_not_followed() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let reply = h.call_as("s1", "navigate", json!({ "url": "http://localhost:3000/" })).await;
    let tab = tab_of(&reply);
    h.pane.user_navigates(&tab, &about_url(&d));
    let_checks_run().await;
    assert!(h.pane.file_loads.lock().is_empty(), "only a file page's own links are followed");
}

/// The tests run on one thread: a check spawned by the hook runs only once
/// the test awaits, so what the test does before that lands mid-check.
#[tokio::test]
async fn stop_after_the_hop_is_cancelled_keeps_the_target_ungranted_and_unloaded() {
    use crate::browser_automation::BrowserHost;
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = about_url(&d);
    h.pane.user_navigates(&tab, &about);
    h.host.stop("s1");
    h.host.user_turn("s1");
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1, "nothing loaded after Stop");
    assert!(!granted(&h, &about), "nothing granted");
}

#[tokio::test]
async fn a_tab_that_moved_on_while_the_check_ran_is_left_alone() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = about_url(&d);
    h.pane.user_navigates(&tab, &about);
    if let Some(record) = h.host.registry.lock().get_mut(&tab) {
        record.url = "http://localhost:3000/elsewhere".to_string();
    }
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1, "the moved tab is not sent back");
    assert!(!granted(&h, &about));
}

/// After a revoke the page's own grant is gone: its script cannot grant
/// itself further project files.
#[tokio::test]
async fn a_page_whose_grant_was_revoked_cannot_follow_links() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    h.host.gate.revoke_access("s1");
    let about = about_url(&d);
    h.pane.user_navigates(&tab, &about);
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1);
    assert!(!granted(&h, &about));
}

#[tokio::test]
async fn a_revoke_during_the_check_stops_the_follow() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    let about = about_url(&d);
    h.pane.user_navigates(&tab, &about);
    h.host.gate.revoke_access("s1");
    let_checks_run().await;
    assert_eq!(h.pane.file_loads.lock().len(), 1);
    assert!(!granted(&h, &about));
}

#[tokio::test]
async fn a_tab_runs_one_follow_at_a_time() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    h.pane.user_navigates(&tab, &about_url(&d));
    h.pane.user_navigates(&tab, &file_url(&d.outside.path().join("a.html")));
    let real = real_url(&d.project.path().join("dist/about.html"));
    settle(&h, |h| h.pane.file_loads.lock().iter().any(|(url, _)| *url == real)).await;
    let registry = h.host.registry.lock();
    let record = registry.get(&tab).unwrap();
    assert!(record.file_links.is_empty(), "the second hop was dropped while the first was checked");
    assert!(!record.file_link_busy, "the tab takes links again");
}

#[test]
fn a_note_cuts_its_url() {
    let long: Url = format!("file:///{}.html", "a".repeat(4000)).parse().unwrap();
    let note = FileLinkNote::new(&long, "outside_project");
    assert!(note.url.len() <= MAX_NOTE_URL_BYTES);
    assert!(long.as_str().starts_with(&note.url));
}

#[tokio::test]
async fn a_tab_keeps_at_most_the_newest_notes() {
    let d = dirs();
    let (h, _perms) = harness(d.project.path());
    let tab = open_index(&h, &d).await;
    for n in 0..(MAX_NOTES + 4) {
        let url: Url = format!("file:///nowhere/{n}.html").parse().unwrap();
        h.host.note_file_link(&tab, &url, "file_not_found");
    }
    let registry = h.host.registry.lock();
    let notes = &registry.get(&tab).unwrap().file_links;
    assert_eq!(notes.len(), MAX_NOTES);
    assert!(notes[MAX_NOTES - 1].url.ends_with(&format!("{}.html", MAX_NOTES + 3)), "the newest is kept");
    assert!(notes[0].url.ends_with("/4.html"), "the oldest went first");
}
