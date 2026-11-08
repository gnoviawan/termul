use std::fs;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;

use super::*;

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
    fs::write(d.project.path().join("dist/index.html"), b"<h1>built</h1>").unwrap();
    fs::write(d.project.path().join(".env"), b"FAKE_TOKEN=not-real").unwrap();
    fs::write(d.outside.path().join("a.html"), b"<p>notes</p>").unwrap();
    fs::create_dir_all(d.outside.path().join(".ssh")).unwrap();
    fs::write(d.outside.path().join(".ssh/id_rsa"), b"FAKE KEY").unwrap();
    d
}

fn file_url(path: &Path) -> String {
    Url::from_file_path(path).expect("absolute path").to_string()
}

fn check(root: &Path, path: &Path) -> Result<LocalFile, FileRefusal> {
    check_local_file(Some(root), &file_url(path))
}

#[test]
fn a_project_file_is_inside_and_loads_by_its_real_path() {
    let d = dirs();
    let page = d.project.path().join("dist/index.html");
    let file = check(d.project.path(), &page).expect("project page");
    assert!(file.inside);
    let real = fs::canonicalize(page.as_path()).unwrap();
    assert_eq!(file.url, Url::from_file_path(real).unwrap());
    assert_eq!(file.read_access, plain(&fs::canonicalize(d.project.path()).unwrap()));
    assert!(!file.display().starts_with(r"\\?\"), "shown in its everyday spelling");
}

#[test]
fn a_file_elsewhere_is_outside_and_may_read_only_itself() {
    let d = dirs();
    let note = d.outside.path().join("a.html");
    let file = check(d.project.path(), &note).expect("outside file");
    assert!(!file.inside);
    assert_eq!(file.read_access, plain(&fs::canonicalize(&note).unwrap()));
    let rootless = check_local_file(None, &file_url(&note)).expect("no project");
    assert!(!rootless.inside, "with no project folder every file is outside");
}

#[test]
fn secrets_are_refused_by_full_and_project_relative_path() {
    let d = dirs();
    assert_eq!(
        check(d.project.path(), &d.project.path().join(".env")).unwrap_err(),
        FileRefusal::SecretFile
    );
    assert_eq!(
        check(d.project.path(), &d.outside.path().join(".ssh/id_rsa")).unwrap_err(),
        FileRefusal::SecretFile
    );
    assert_eq!(FileRefusal::SecretFile.into_error().reason, Some("secret_file"));
    assert_eq!(FileRefusal::SecretFile.into_error().code, super::super::ERR_INVALID_PARAMS);
}

#[test]
fn a_link_to_a_secret_is_judged_by_where_it_leads() {
    let d = dirs();
    let link = d.project.path().join("dist/notes.html");
    if !files::symlink_file(&d.outside.path().join(".ssh/id_rsa"), &link) {
        eprintln!("skipped: this account cannot create symlinks");
        return;
    }
    assert_eq!(check(d.project.path(), &link).unwrap_err(), FileRefusal::SecretFile);
}

#[test]
fn a_link_out_of_the_project_is_an_outside_file() {
    let d = dirs();
    let link = d.project.path().join("dist/elsewhere.html");
    if !files::symlink_file(&d.outside.path().join("a.html"), &link) {
        eprintln!("skipped: this account cannot create symlinks");
        return;
    }
    let file = check(d.project.path(), &link).expect("opens as the outside file");
    assert!(!file.inside, "the real path decides, not the name inside the project");
    assert_eq!(file.url, Url::from_file_path(fs::canonicalize(d.outside.path().join("a.html")).unwrap()).unwrap());
}

#[test]
fn folders_missing_files_and_hard_links_are_refused() {
    let d = dirs();
    let folder = format!("{}/", file_url(&d.project.path().join("dist")));
    assert_eq!(check_local_file(Some(d.project.path()), &folder).unwrap_err(), FileRefusal::NotAFile);
    assert_eq!(
        check(d.project.path(), &d.project.path().join("dist")).unwrap_err(),
        FileRefusal::NotAFile
    );
    assert_eq!(
        check(d.project.path(), &d.project.path().join("dist/missing.html")).unwrap_err(),
        FileRefusal::Missing
    );
    let second = d.project.path().join("dist/second-name.html");
    fs::hard_link(d.project.path().join("dist/index.html"), &second).unwrap();
    assert_eq!(check(d.project.path(), &second).unwrap_err(), FileRefusal::HardLinked);
}

/// A filesystem root (or anything holding the home folder) is no project:
/// every file under it is an outside file, readable on its own only.
#[test]
fn a_broad_root_makes_every_file_an_outside_file() {
    let d = dirs();
    let note = d.outside.path().join("a.html");
    let drive = d.outside.path().ancestors().last().expect("a filesystem root").to_path_buf();
    let file = check(&drive, &note).expect("the file opens");
    assert!(!file.inside, "{} is not a project", drive.display());
    assert_eq!(file.read_access, plain(&fs::canonicalize(&note).unwrap()));
    if let Some(home) = files::home_dir() {
        if let Some(parent) = home.parent() {
            assert!(is_broad(parent), "a folder holding home is broad");
        }
        assert!(is_broad(&home));
    }
}

#[test]
fn network_shares_and_other_schemes_are_refused() {
    assert_eq!(
        check_local_file(None, "file://server/share/x.html").unwrap_err(),
        FileRefusal::NetworkShare
    );
    assert_eq!(FileRefusal::NetworkShare.into_error().reason, Some("network_share"));
    for bad in ["https://example.com/x.html", "not a url", "data:text/html,x"] {
        assert_eq!(check_local_file(None, bad).unwrap_err(), FileRefusal::InvalidUrl, "{bad}");
    }
}

/// Whether this host's paths are Windows paths (the core keeps no
/// platform cfgs, so the platform is read at run time).
const WINDOWS: bool = std::path::MAIN_SEPARATOR == '\\';

/// `index.html:hidden` names a stream on Windows; elsewhere it is just a
/// file name, here a missing one.
#[test]
fn an_ntfs_stream_is_refused_on_windows_only() {
    let d = dirs();
    let url = format!("{}:hidden", file_url(&d.project.path().join("dist/index.html")));
    let expected = if WINDOWS { FileRefusal::Stream } else { FileRefusal::Missing };
    assert_eq!(check_local_file(Some(d.project.path()), &url).unwrap_err(), expected);
}

#[test]
fn a_colon_in_a_file_name_is_a_stream_on_windows_only() {
    assert_eq!(names_a_stream(Path::new("notes:v2.html")), WINDOWS);
    assert_eq!(names_a_stream(Path::new("site/notes:v2.html")), WINDOWS);
    assert!(!names_a_stream(Path::new("site/notes-v2.html")));
}

#[test]
fn only_a_verbatim_drive_path_loses_its_prefix() {
    assert_eq!(plain(Path::new(r"\\?\C:\proj\a.html")), PathBuf::from(r"C:\proj\a.html"));
    for kept in [r"\\?\UNC\server\share\a.html", r"\\?\Volume{0b1c}\proj\a.html", "/home/me/a.html"] {
        assert_eq!(plain(Path::new(kept)), PathBuf::from(kept), "{kept}");
    }
}

#[tokio::test]
async fn file_checks_are_admitted_only_while_a_slot_is_free() {
    let d = dirs();
    let page = file_url(&d.project.path().join("dist/index.html"));
    let full = Arc::new(Semaphore::new(0));
    let busy = bounded_check(&full, Some(d.project.path().to_path_buf()), page.clone(), Duration::from_millis(50)).await;
    assert_eq!(busy.err(), Some(CheckStall::Busy));
    assert_eq!(CheckStall::Busy.reason(), "file_check_busy");

    let one = Arc::new(Semaphore::new(1));
    let checked = bounded_check(&one, Some(d.project.path().to_path_buf()), page, Duration::from_secs(5)).await;
    assert!(checked.is_ok_and(|file| file.is_ok_and(|file| file.inside)));
    assert_eq!(one.available_permits(), 1, "the slot comes back once the work ends");
}

#[test]
fn only_file_urls_are_file_targets() {
    assert!(is_file_url("file:///tmp/a.html"));
    assert!(!is_file_url("https://example.com/"));
    assert!(!is_file_url("not a url"));
}

#[test]
fn the_shared_deny_list_still_marks_upload_secrets() {
    assert!(is_secret(Path::new("home/.aws/config")));
    assert!(is_secret(Path::new("deploy.KEY")));
    assert!(!is_secret(Path::new("environment.md")));
    assert_eq!(names_a_stream(Path::new("a.txt:stream")), WINDOWS);
}

/// The host end to end: the agent's file target is checked, granted and
/// loaded by its real path, through the same calls the desktop makes.
mod host {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::browser_automation::core::ports::{ActionClass, TicketOutcome};
    use crate::browser_automation::core::test_support::{InMemoryPolicyStore, ScriptedPermissions};
    use crate::browser_automation::core::tests::{harness_parts, tab_of, webview2_like, FakeEngine, Harness};
    use crate::browser_automation::core::HostServices;
    use crate::browser_automation::engine::Support;

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

    #[tokio::test]
    async fn a_project_page_opens_without_a_prompt_at_its_real_path() {
        let d = dirs();
        let (h, perms) = harness(d.project.path());
        let page = d.project.path().join("dist/index.html");
        let reply = h.call_as("s1", "navigate", json!({ "url": file_url(&page) })).await;
        assert_eq!(reply["ok"], true, "{reply}");
        assert!(perms.requests.lock().is_empty(), "no prompt for a project file");
        let real = Url::from_file_path(fs::canonicalize(page.as_path()).unwrap()).unwrap().to_string();
        let loads = h.engine.file_loads.lock().clone();
        assert_eq!(loads.len(), 1, "{loads:?}");
        assert_eq!(loads[0].0, real, "the engine gets the real path, never the agent's string");
        assert_eq!(loads[0].1, plain(&fs::canonicalize(d.project.path()).unwrap()));
        assert_eq!(reply["page"]["url"], real);

        let tab = tab_of(&reply);
        let events = h.pane.events(&tab);
        assert!(events.frame_starting(&real.parse().unwrap()), "the granted page may frame itself");
        let key = Url::from_file_path(d.outside.path().join(".ssh/id_rsa")).unwrap();
        assert!(!events.frame_starting(&key), "an embedded file with no grant is blocked");
        let sibling = Url::from_file_path(d.project.path().join(".env")).unwrap();
        assert!(!events.frame_starting(&sibling));
        assert!(events.frame_starting(&"https://example.com/embed".parse().unwrap()), "web frames keep their rules");
    }

    #[tokio::test]
    async fn new_tab_opens_a_project_page_too() {
        let d = dirs();
        let (h, perms) = harness(d.project.path());
        let page = d.project.path().join("dist/index.html");
        let reply = h.call_as("s1", "new_tab", json!({ "url": file_url(&page) })).await;
        assert_eq!(reply["ok"], true, "{reply}");
        assert!(perms.requests.lock().is_empty());
        assert_eq!(h.engine.file_loads.lock().len(), 1);
    }

    #[tokio::test]
    async fn a_file_outside_the_project_asks_and_unanswered_is_confirmation_required() {
        let d = dirs();
        let (h, perms) = harness(d.project.path());
        let reply = h
            .call_as("s1", "navigate", json!({ "url": file_url(&d.outside.path().join("a.html")) }))
            .await;
        assert_eq!((reply["code"].as_str(), reply["reason"].as_str()), (Some("confirmation_required"), Some("unattended")), "{reply}");
        let requests = perms.requests.lock();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0.origin.kind(), "file");
        assert_eq!(requests[0].0.action, ActionClass::Navigate);
        assert!(h.engine.file_loads.lock().is_empty(), "nothing loaded");
    }

    #[tokio::test]
    async fn an_allowed_outside_file_loads_with_access_to_itself_only() {
        let d = dirs();
        let root = d.project.path().to_path_buf();
        let perms = Arc::new(ScriptedPermissions::answering([TicketOutcome::Answered(
            crate::browser_automation::core::ports::ConsentOption::AllowSession,
        )]));
        let services = HostServices {
            permissions: perms.clone(),
            policy: Arc::new(InMemoryPolicyStore::opening_sites_unasked()),
            project_of: Arc::new(|_| "p1".to_string()),
            root_of: Arc::new(move |_| Some(root.clone())),
        };
        let h = harness_parts(FakeEngine::new(webview2_like()), false, services, Support::Trusted);
        let note = d.outside.path().join("a.html");
        let reply = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        assert_eq!(reply["ok"], true, "{reply}");
        let loads = h.engine.file_loads.lock().clone();
        assert_eq!(loads[0].1, plain(&fs::canonicalize(note.as_path()).unwrap()));
    }

    #[tokio::test]
    async fn secrets_folders_and_shares_are_refused_without_a_prompt() {
        let d = dirs();
        let (h, perms) = harness(d.project.path());
        for (url, reason) in [
            (file_url(&d.project.path().join(".env")), "secret_file"),
            (file_url(&d.outside.path().join(".ssh/id_rsa")), "secret_file"),
            (format!("{}/", file_url(&d.project.path().join("dist"))), "not_a_file"),
            ("file://server/share/x.html".to_string(), "network_share"),
        ] {
            let reply = h.call_as("s1", "navigate", json!({ "url": url })).await;
            assert_eq!(
                (reply["code"].as_str(), reply["reason"].as_str()),
                (Some("invalid_params"), Some(reason)),
                "{url}: {reply}"
            );
        }
        assert!(perms.requests.lock().is_empty());
        assert!(h.engine.file_loads.lock().is_empty());
    }

    #[tokio::test]
    async fn public_and_lan_sites_open_without_a_prompt_by_default() {
        let d = dirs();
        let (h, perms) = harness(d.project.path());
        for url in ["https://new.example/", "http://192.168.1.1/"] {
            let reply = h.call_as("s1", "navigate", json!({ "url": url })).await;
            assert_eq!(reply["ok"], true, "{url}: {reply}");
        }
        assert!(perms.requests.lock().is_empty());
        let denied = h.call_as("s1", "navigate", json!({ "url": "http://169.254.169.254/" })).await;
        assert_eq!(denied["code"], "invalid_params", "{denied}");
    }

    /// Answers every ticket "allow once", but first swaps the outside file
    /// for a link to another file, as a racing process would.
    struct SwapWhileAsking {
        file: std::path::PathBuf,
        target: std::path::PathBuf,
    }

    impl crate::browser_automation::core::ports::PermissionRequest for SwapWhileAsking {
        fn request(
            &self,
            _ticket: crate::browser_automation::core::ports::TicketRequest,
            _wait: std::time::Duration,
        ) -> crate::browser_automation::core::ports::PortFuture<'_, TicketOutcome> {
            let _ = fs::remove_file(&self.file);
            let _ = files::symlink_file(&self.target, &self.file);
            Box::pin(async {
                TicketOutcome::Answered(crate::browser_automation::core::ports::ConsentOption::AllowSession)
            })
        }

        fn cancel_session(&self, _session_id: &str) {}
    }

    #[tokio::test]
    async fn a_file_swapped_after_approval_is_not_loaded() {
        let d = dirs();
        let note = d.outside.path().join("a.html");
        let other = d.outside.path().join("b.html");
        fs::write(&other, b"<p>other</p>").unwrap();
        let probe = d.outside.path().join("probe.html");
        if !files::symlink_file(&other, &probe) {
            eprintln!("skipped: this account cannot create symlinks");
            return;
        }
        let root = d.project.path().to_path_buf();
        let services = HostServices {
            permissions: Arc::new(SwapWhileAsking { file: note.clone(), target: other }),
            policy: Arc::new(InMemoryPolicyStore::opening_sites_unasked()),
            project_of: Arc::new(|_| "p1".to_string()),
            root_of: Arc::new(move |_| Some(root.clone())),
        };
        let h = harness_parts(FakeEngine::new(webview2_like()), false, services, Support::Trusted);
        let reply = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        assert_eq!(
            (reply["code"].as_str(), reply["reason"].as_str()),
            (Some("confirmation_required"), Some("file_changed")),
            "{reply}"
        );
        assert!(h.engine.file_loads.lock().is_empty(), "the swapped file never loads");
    }

    #[tokio::test]
    async fn a_verb_on_a_file_tab_after_stop_or_revoke_is_file_not_granted() {
        use crate::browser_automation::BrowserHost;
        let d = dirs();
        let (h, _perms) = harness(d.project.path());
        let page = d.project.path().join("dist/index.html");
        let opened = h.call_as("s1", "navigate", json!({ "url": file_url(&page) })).await;
        assert_eq!(opened["ok"], true, "{opened}");
        assert_eq!(h.call_as("s1", "snapshot", json!({})).await["ok"], true);

        h.host.stop("s1");
        h.host.user_turn("s1");
        let after_stop = h.call_as("s1", "snapshot", json!({})).await;
        assert_eq!(
            (after_stop["code"].as_str(), after_stop["reason"].as_str()),
            (Some("invalid_params"), Some("file_not_granted")),
            "{after_stop}"
        );
        assert!(after_stop["message"].as_str().unwrap().contains("call navigate"));

        let reopened = h.call_as("s1", "navigate", json!({ "url": file_url(&page) })).await;
        assert_eq!(reopened["ok"], true, "{reopened}");
        h.host.gate.revoke_access("s1");
        let after_revoke = h.call_as("s1", "snapshot", json!({})).await;
        assert_eq!(
            (after_revoke["code"].as_str(), after_revoke["reason"].as_str()),
            (Some("invalid_params"), Some("file_not_granted")),
            "{after_revoke}"
        );
    }

    /// The agent's query and fragment reach the page; the grant ignores
    /// them.
    #[tokio::test]
    async fn a_query_and_fragment_survive_to_the_loaded_url() {
        let d = dirs();
        let (h, _perms) = harness(d.project.path());
        let page = d.project.path().join("dist/index.html");
        let asked = format!("{}?tab=2#intro", file_url(&page));
        let reply = h.call_as("s1", "navigate", json!({ "url": asked })).await;
        assert_eq!(reply["ok"], true, "{reply}");
        let loads = h.engine.file_loads.lock().clone();
        assert!(loads[0].0.ends_with("index.html?tab=2#intro"), "{loads:?}");
        let real = Url::from_file_path(fs::canonicalize(page.as_path()).unwrap()).unwrap();
        assert!(h.host.gate.file_read_access("s1", &real).is_some(), "the grant is the bare real path");
    }

    fn allowing(project: &Path, answers: Vec<TicketOutcome>) -> (Harness, Arc<ScriptedPermissions>) {
        let root = project.to_path_buf();
        let permissions = Arc::new(ScriptedPermissions::answering(answers));
        let services = HostServices {
            permissions: permissions.clone(),
            policy: Arc::new(InMemoryPolicyStore::opening_sites_unasked()),
            project_of: Arc::new(|_| "p1".to_string()),
            root_of: Arc::new(move |_| Some(root.clone())),
        };
        let h = harness_parts(FakeEngine::new(webview2_like()), false, services, Support::Trusted);
        (h, permissions)
    }

    fn allow() -> TicketOutcome {
        TicketOutcome::Answered(crate::browser_automation::core::ports::ConsentOption::AllowSession)
    }

    #[tokio::test]
    async fn an_allowed_outside_file_keeps_working_while_its_tab_stays_on_it() {
        let d = dirs();
        let (h, _perms) = allowing(d.project.path(), vec![allow()]);
        let note = d.outside.path().join("a.html");
        let reply = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        assert_eq!(reply["ok"], true, "{reply}");
        h.settle_events().await;
        for verb in ["snapshot", "screenshot", "read_text"] {
            let reply = h.call_as("s1", verb, json!({})).await;
            assert_eq!(reply["ok"], true, "{verb}: {reply}");
        }
    }

    #[tokio::test]
    async fn leaving_an_allowed_outside_file_ends_its_grant() {
        let d = dirs();
        let (h, _perms) = allowing(d.project.path(), vec![allow()]);
        let note = d.outside.path().join("a.html");
        let opened = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        let tab = tab_of(&opened);
        h.settle_events().await;
        let away = h.call_as("s1", "navigate", json!({ "url": "http://localhost:3000/" })).await;
        assert_eq!(away["ok"], true, "{away}");
        h.settle_events().await;
        let real = Url::from_file_path(fs::canonicalize(note.as_path()).unwrap()).unwrap();
        assert!(h.host.gate.file_read_access("s1", &real).is_none(), "the page left the file");
        h.pane.user_navigates(&tab, real.as_str());
        h.settle_events().await;
        let url = h.host.registry.lock().get(&tab).map(|r| r.url.clone());
        assert_eq!(url.as_deref(), Some("http://localhost:3000/"), "a page-started hop back is denied");
    }

    #[tokio::test]
    async fn denying_a_later_prompt_ends_an_earlier_allow_once() {
        let d = dirs();
        let deny = TicketOutcome::Answered(crate::browser_automation::core::ports::ConsentOption::Deny);
        let (h, _perms) = allowing(d.project.path(), vec![allow(), deny]);
        let note = d.outside.path().join("a.html");
        let first = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        assert_eq!(first["ok"], true, "{first}");
        let second = h.call_as("s1", "navigate", json!({ "url": file_url(&note) })).await;
        assert_eq!(second["reason"], "denied_by_user", "{second}");
        let real = Url::from_file_path(fs::canonicalize(note.as_path()).unwrap()).unwrap();
        assert!(h.host.gate.file_read_access("s1", &real).is_none());
    }
}
