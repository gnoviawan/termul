//! Real-engine agent profile fixture. Tab webviews are built through
//! `BrowserTabManager` on the data stores the host picks: the app's own
//! profile for a user tab, the global agent profile, and per-session
//! ephemeral profiles. Each page sets a cookie named after its tab, or
//! only reads, and reports `document.cookie` in its URL fragment.
//!
//! The test runs each phase in a fresh child process, so the second phase
//! is an app restart against what the first left on disk:
//!
//! 1. a project-A session logs in on the global profile and a second global
//!    tab sees the login; a user tab and two concurrent ephemeral sessions
//!    set their own cookies; then one ephemeral session ends and its
//!    directory is deleted;
//! 2. after the restart a project-B session's global tab is still logged
//!    in, the user tab still sees only its own cookie, a new ephemeral
//!    session starts logged out; clearing the global profile then leaves a
//!    new global tab logged out.
//!
//! It runs from the conformance runner's binary, which owns the main
//! thread as macOS needs, and only when asked:
//!
//! ```text
//! TERMUL_PROFILE_FIXTURE=1 cargo test --test browser_conformance -- --nocapture
//! ```

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};
use uuid::Uuid;

use termul_manager_lib::conformance_support::{
    delete_dir, BrowserBounds, BrowserTabManager, DataStore, NavPolicy, NavVerdict, TabEvents,
};

/// Runs the fixture instead of the conformance suite.
pub const ENABLE_VAR: &str = "TERMUL_PROFILE_FIXTURE";
const PHASE_VAR: &str = "TERMUL_PROFILE_FIXTURE_PHASE";
const OUT_VAR: &str = "TERMUL_PROFILE_FIXTURE_OUT";
const IDENTIFIER: &str = "com.termul-manager.profile-fixture";
const REPORT_DEADLINE: Duration = Duration::from_secs(45);
/// Lets the engine write its cookie store before the process exits.
const FLUSH: Duration = Duration::from_secs(3);

fn page_body(path: &str) -> String {
    let set = path
        .strip_prefix("/set?")
        .map(|name| format!("document.cookie = '{name}=1; max-age=86400; path=/';"))
        .unwrap_or_default();
    format!(
        "<!doctype html><title>profile</title><script>{set}\
         location.hash = 'seen=' + encodeURIComponent(document.cookie);</script>"
    )
}

/// Serves `/set?<name>` (set a cookie, then report) and anything else
/// (report only). Returns the port.
fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let port = listener.local_addr().expect("fixture addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split(' ').nth(1))
                .unwrap_or("/")
                .to_string();
            let body = page_body(&path);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    port
}

struct AllowAll;

impl NavPolicy for AllowAll {
    fn decide(&self, _tab: &str, _url: &Url) -> NavVerdict {
        NavVerdict::Allow
    }
}

/// Cookie names a tab's page reported, sorted; `None` until it reported.
fn seen(handle: &AppHandle, label: &str) -> Option<Vec<String>> {
    let url = handle.get_webview(label)?.url().ok()?;
    let encoded = url.fragment()?.strip_prefix("seen=")?.to_string();
    let decoded = percent_decode(&encoded)?;
    let mut names: Vec<String> = decoded
        .split(';')
        .filter_map(|pair| pair.split('=').next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    Some(names)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One phase's driver, on its own thread while the event loop runs.
struct Driver {
    handle: AppHandle,
    manager: Arc<BrowserTabManager>,
    origin: String,
    sessions: PathBuf,
    report: BTreeMap<String, serde_json::Value>,
    opened: usize,
}

impl Driver {
    fn ephemeral(&self, session: &str) -> DataStore {
        DataStore::Ephemeral {
            dir: self.sessions.join(session).join("profile"),
        }
    }

    /// Open a tab on `store` at `path` and wait for its page to report.
    fn open(&mut self, name: &str, user: bool, store: DataStore, path: &str) -> String {
        let label = if user {
            format!("tab-{}", Uuid::new_v4())
        } else {
            format!("agent-{}", Uuid::new_v4())
        };
        let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
        let events = TabEvents::new(&label, tx, Arc::new(AllowAll));
        let index = self.opened;
        self.opened += 1;
        let bounds = BrowserBounds {
            x: 320.0 + (index % 4) as f64 * 160.0,
            y: (index / 4) as f64 * 160.0,
            width: 150.0,
            height: 150.0,
        };
        let url = format!("{}{path}", self.origin);
        let created = tauri::async_runtime::block_on(self.manager.create(
            label.clone(),
            url,
            bounds,
            events,
            store,
        ));
        if let Err(error) = created {
            self.report
                .insert(name.to_string(), serde_json::json!({ "error": error }));
            return label;
        }
        let started = Instant::now();
        let cookies = loop {
            if let Some(names) = seen(&self.handle, &label) {
                break serde_json::json!(names);
            }
            if started.elapsed() > REPORT_DEADLINE {
                break serde_json::Value::Null;
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        self.report.insert(name.to_string(), cookies);
        label
    }

    fn close(&self, label: &str) {
        tauri::async_runtime::block_on(self.manager.destroy(label));
    }

    fn first(&mut self) {
        self.open("user", true, DataStore::App, "/set?user");
        let global = self.open("global_a", false, DataStore::Global, "/set?login");
        let shared = self.open("global_a_second_tab", false, DataStore::Global, "/read");
        self.close(&shared);
        let e1 = self.open("ephemeral_1", false, self.ephemeral("e1"), "/set?e1");
        let e2 = self.open("ephemeral_2", false, self.ephemeral("e2"), "/set?e2");
        self.close(&e1);
        let dir = self.sessions.join("e1");
        let existed = dir.exists();
        let deleted = delete_dir(&dir);
        self.report.insert(
            "ephemeral_1_dir".to_string(),
            serde_json::json!({ "existed": existed, "deleted": deleted, "gone": !dir.exists() }),
        );
        self.close(&e2);
        self.close(&global);
    }

    fn second(&mut self) {
        self.open("user_after_restart", true, DataStore::App, "/read");
        let global = self.open("global_b", false, DataStore::Global, "/read");
        let fresh = self.open("ephemeral_3", false, self.ephemeral("e3"), "/read");
        self.close(&fresh);
        self.close(&global);
        let wiped = tauri::async_runtime::block_on(self.manager.wipe_global_profile());
        self.report
            .insert("wipe".to_string(), serde_json::json!(wiped.err()));
        let cleared = self.open("global_after_clear", false, DataStore::Global, "/read");
        self.close(&cleared);
    }
}

fn run_phase(phase: &str, out: &Path, mut context: tauri::Context<tauri::Wry>) {
    let tabs_port = serve();
    let dev_port = serve();
    let report: Arc<Mutex<BTreeMap<String, serde_json::Value>>> = Arc::default();
    let sink = report.clone();
    let phase = phase.to_string();

    context.config_mut().identifier = IDENTIFIER.to_string();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url =
        Some(format!("http://localhost:{dev_port}/").parse().unwrap());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .setup(move |app| {
            if phase == "first" {
                for dir in [app.path().app_data_dir()?, app.path().app_local_data_dir()?] {
                    delete_dir(&dir);
                }
            }
            let window = tauri::window::WindowBuilder::new(app, "main")
                .inner_size(1000.0, 640.0)
                .build()?;
            window.add_child(
                WebviewBuilder::new("main", WebviewUrl::App("main.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(300.0, 300.0),
            )?;
            let manager = Arc::new(BrowserTabManager::new(app.handle().clone()));
            let handle = app.handle().clone();
            let sessions = app.path().app_data_dir()?.join("browser-sessions");
            std::thread::spawn(move || {
                let mut driver = Driver {
                    handle: handle.clone(),
                    manager,
                    origin: format!("http://127.0.0.1:{tabs_port}"),
                    sessions,
                    report: BTreeMap::new(),
                    opened: 0,
                };
                match phase.as_str() {
                    "first" => driver.first(),
                    _ => driver.second(),
                }
                std::thread::sleep(FLUSH);
                *sink.lock().unwrap() = std::mem::take(&mut driver.report);
                handle.exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("fixture app builds");
    let dirs = [
        app.path().app_data_dir().ok(),
        app.path().app_local_data_dir().ok(),
    ];
    app.run_return(|_, _| {});
    let mut report = report.lock().unwrap().clone();
    report.insert("dirs".to_string(), serde_json::json!(dirs));
    std::fs::write(out, serde_json::to_vec_pretty(&report).unwrap()).expect("write phase report");
}

fn run_child(phase: &str, out: &Path) -> BTreeMap<String, serde_json::Value> {
    let status = Command::new(std::env::current_exe().expect("runner executable"))
        .env(PHASE_VAR, phase)
        .env(OUT_VAR, out)
        .status()
        .expect("phase process starts");
    assert!(status.success(), "phase {phase} exited with {status}");
    let bytes = std::fs::read(out).expect("phase report written");
    serde_json::from_slice(&bytes).expect("phase report parses")
}

fn names(list: &[&str]) -> serde_json::Value {
    serde_json::json!(list)
}

/// One phase when the parent started this process for it, otherwise the
/// whole fixture. Panics on the first unexpected observation.
pub fn main(context: tauri::Context<tauri::Wry>) {
    if let (Ok(phase), Some(out)) = (std::env::var(PHASE_VAR), std::env::var_os(OUT_VAR)) {
        run_phase(&phase, Path::new(&out), context);
        return;
    }
    let scratch = tempfile::tempdir().unwrap();
    let first = run_child("first", &scratch.path().join("first.json"));
    eprintln!("profile fixture, first run: {first:#?}");
    let second = run_child("second", &scratch.path().join("second.json"));
    eprintln!("profile fixture, after restart: {second:#?}");
    std::thread::sleep(Duration::from_secs(2));
    for dir in second["dirs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| d.as_str())
    {
        delete_dir(Path::new(dir));
    }

    assert_eq!(
        first["user"],
        names(&["user"]),
        "the user tab sees no agent cookie"
    );
    assert_eq!(
        first["global_a"],
        names(&["login"]),
        "the global profile sees no user cookie"
    );
    assert_eq!(
        first["global_a_second_tab"],
        names(&["login"]),
        "a second global tab shares the first one's environment"
    );
    assert_eq!(
        first["ephemeral_1"],
        names(&["e1"]),
        "concurrent ephemeral sessions are isolated"
    );
    assert_eq!(
        first["ephemeral_2"],
        names(&["e2"]),
        "concurrent ephemeral sessions are isolated"
    );
    let dir = &first["ephemeral_1_dir"];
    assert_eq!(
        (&dir["deleted"], &dir["gone"]),
        (&serde_json::json!(true), &serde_json::json!(true))
    );
    assert_eq!(
        dir["existed"],
        serde_json::json!(cfg!(windows)),
        "only WebView2 keeps an ephemeral profile on disk"
    );

    assert_eq!(
        second["global_b"],
        names(&["login"]),
        "a project-A login is valid in project B after a restart"
    );
    assert_eq!(
        second["user_after_restart"],
        names(&["user"]),
        "the user profile still has no agent cookie"
    );
    assert_eq!(
        second["ephemeral_3"],
        names(&[]),
        "an ephemeral session starts logged out"
    );
    assert_eq!(
        second["wipe"],
        serde_json::Value::Null,
        "the wipe succeeded"
    );
    assert_eq!(
        second["global_after_clear"],
        names(&[]),
        "clearing logged the global profile out"
    );
    println!("profile fixture: every check passed");
}
