//! Real-engine perimeter fixture. One window holds the main webview and tab
//! webviews created through `BrowserTabManager`, the same path the app uses,
//! behind the same command guard and navigation verdict. The host evaluates
//! a probe in every webview. Once per document it reports whether Tauri's
//! IPC bridge is present, the outcome of one app command and one plugin
//! command, and whether agentation was injected, by writing the result into
//! the URL fragment that the host reads back with `Webview::url`.
//!
//! Denied targets are tried three ways: `BrowserTabManager::create` and
//! `BrowserTabManager::navigate` must refuse them before the engine starts a
//! request, and a loaded page that navigates itself to one must stay put.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

use super::ProbeRuns;
use crate::browser_automation::engine::events::{NavPolicy, NavVerdict, TabEvents};
use crate::browser_automation::engine::profile::DataStore;
use crate::browser_tab_manager::{BrowserBounds, BrowserTabManager};
use crate::host_perimeter::{allow_tab_navigation, main_webview_only, OwnedPort};

const PROBE: &str = r#"
(function () {
  if (window.__perimeterProbed) return;
  window.__perimeterProbed = true;
  var internals = window.__TAURI_INTERNALS__;
  var out = {
    origin: location.origin,
    internals: !!internals,
    agentation: typeof window.__TERMUL_AGENTATION_ENDPOINT__ === 'string',
    app: 'absent',
    plugin: 'absent'
  };
  function call(cmd) {
    return internals.invoke(cmd, {}).then(function () { return 'resolved'; }, function () { return 'rejected'; });
  }
  var done = internals
    ? call('perimeter_probe').then(function (app) {
        out.app = app;
        return call('plugin:os|locale');
      }).then(function (plugin) { out.plugin = plugin; })
    : Promise.resolve();
  done.then(function () {
    location.hash = 'perimeter=' + encodeURIComponent(JSON.stringify(out));
  });
})();
"#;

/// Query marking the requests of page-initiated navigations.
const PAGE_NAVIGATION: &str = "page-navigation";
const SETTLE: Duration = Duration::from_secs(6);
const DEADLINE: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeOutcome {
    origin: String,
    internals: bool,
    agentation: bool,
    app: String,
    plugin: String,
}

#[derive(Debug)]
struct Report {
    /// Per webview label: the probe outcome of the current document, or
    /// `None` when no document reported.
    outcomes: BTreeMap<String, Option<ProbeOutcome>>,
    app_command_runs: usize,
    /// `BrowserTabManager` results for denied targets, by attempt.
    refused: BTreeMap<String, Result<(), String>>,
    /// Request targets (path and query) each fixture server received.
    remote_requests: Vec<String>,
    dev_requests: Vec<String>,
    owned_requests: Vec<String>,
    remote_origin: String,
    dev_origin: String,
}

fn serve_fixture_page() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let port = listener.local_addr().expect("fixture addr").port();
    let requests: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            // A speculative preconnect opens a socket but sends nothing.
            let read = stream.read(&mut buf).unwrap_or(0);
            if let Some(target) = String::from_utf8_lossy(&buf[..read])
                .lines()
                .next()
                .and_then(|line| line.split(' ').nth(1))
            {
                log.lock().unwrap().push(target.to_string());
            }
            let body = "<!doctype html><title>fixture</title><p>fixture</p>";
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, requests)
}

fn app_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

fn outcome_from(url: &Url) -> Option<ProbeOutcome> {
    let encoded = url.fragment()?.strip_prefix("perimeter=")?;
    let value: serde_json::Value = serde_json::from_str(&percent_decode(encoded)?).ok()?;
    Some(ProbeOutcome {
        origin: value["origin"].as_str()?.to_string(),
        internals: value["internals"].as_bool()?,
        agentation: value["agentation"].as_bool()?,
        app: value["app"].as_str()?.to_string(),
        plugin: value["plugin"].as_str()?.to_string(),
    })
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

/// The perimeter half of the app's per-hop verdict; these tabs belong to no
/// agent session, so it is the whole verdict.
struct Perimeter(AppHandle);

impl NavPolicy for Perimeter {
    fn decide(&self, tab: &str, url: &Url) -> NavVerdict {
        if allow_tab_navigation(&self.0, tab, url) {
            NavVerdict::Allow
        } else {
            NavVerdict::Deny
        }
    }
}

fn create_tab(
    manager: &BrowserTabManager,
    handle: &AppHandle,
    label: String,
    url: &str,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let (tx, _events) = tokio::sync::mpsc::unbounded_channel();
    let events = TabEvents::new(&label, tx, Arc::new(Perimeter(handle.clone())));
    tauri::async_runtime::block_on(manager.create(
        label,
        url.to_string(),
        bounds,
        events,
        DataStore::App,
    ))
}

fn run() -> Report {
    let (remote_port, remote_requests) = serve_fixture_page();
    let (dev_port, dev_requests) = serve_fixture_page();
    let (owned_port, owned_requests) = serve_fixture_page();
    let _owned_claim = OwnedPort::claim(owned_port);

    let remote_origin = format!("http://127.0.0.1:{remote_port}");
    let dev_origin = format!("http://localhost:{dev_port}");
    let page = "perimeter-fixture.html";
    let denied_targets: Vec<(&'static str, String)> = vec![
        ("agent-to-dev-origin", format!("{dev_origin}/{page}")),
        ("tab-user-to-dev-origin", format!("{dev_origin}/{page}")),
        ("agent-to-app-origin", format!("{}/{page}", app_origin())),
        (
            "agent-to-owned-port",
            format!("http://127.0.0.1:{owned_port}/owned"),
        ),
        (
            "agent-to-unspecified",
            format!("http://0.0.0.0:{owned_port}/unspecified"),
        ),
        (
            "agent-to-metadata",
            "http://169.254.169.254/latest/meta-data/".to_string(),
        ),
    ];
    let mut loaded_tabs: Vec<(&'static str, String)> = vec![
        ("agent-remote", format!("{remote_origin}/{page}")),
        ("tab-user-remote", format!("{remote_origin}/{page}?user")),
    ];
    loaded_tabs.extend(
        denied_targets
            .iter()
            .map(|(label, _)| (*label, format!("{remote_origin}/{page}?{label}"))),
    );
    // Built without the tab hooks, so no navigation verdict applies: the
    // command guard is tested on an app-origin page that actually loaded.
    let bypass_tabs: Vec<(&'static str, String)> = vec![
        ("bypass-dev-origin", format!("{dev_origin}/{page}")),
        ("bypass-app-origin", format!("{}/{page}", app_origin())),
    ];
    let labels: Vec<String> = std::iter::once("main")
        .chain(loaded_tabs.iter().map(|(label, _)| *label))
        .chain(bypass_tabs.iter().map(|(label, _)| *label))
        .map(str::to_string)
        .collect();

    let runs = Arc::new(ProbeRuns::default());
    let collected: Arc<Mutex<BTreeMap<String, Option<ProbeOutcome>>>> = Arc::default();
    let refused: Arc<Mutex<BTreeMap<String, Result<(), String>>>> = Arc::default();
    let sink = collected.clone();
    let refused_sink = refused.clone();
    let mut context = crate::app_context();
    context.config_mut().identifier = "com.termul-manager.perimeter-fixture".to_string();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some(format!("{dev_origin}/").parse().unwrap());

    let builder = tauri::Builder::default();
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.any_thread();
    let app = builder
        .plugin(tauri_plugin_os::init())
        .manage(runs.clone())
        .invoke_handler(main_webview_only(tauri::generate_handler![
            super::perimeter_probe
        ]))
        .setup(move |app| {
            let window = tauri::window::WindowBuilder::new(app, "main")
                .inner_size(1000.0, 640.0)
                .build()?;
            window.add_child(
                WebviewBuilder::new("main", WebviewUrl::App(page.into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(300.0, 300.0),
            )?;
            for (index, (label, url)) in bypass_tabs.iter().enumerate() {
                window.add_child(
                    WebviewBuilder::new(*label, WebviewUrl::External(url.parse().unwrap())),
                    LogicalPosition::new(index as f64 * 150.0, 320.0),
                    LogicalSize::new(140.0, 140.0),
                )?;
            }
            let manager = Arc::new(BrowserTabManager::new(app.handle().clone()));
            manager.set_agentation_endpoint("http://127.0.0.1:9".to_string());
            app.manage(manager.clone());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let bounds = |index: usize| BrowserBounds {
                    x: 320.0 + (index % 4) as f64 * 160.0,
                    y: (index / 4) as f64 * 160.0,
                    width: 150.0,
                    height: 150.0,
                };
                let mut refusals = BTreeMap::new();
                for (label, target) in &denied_targets {
                    let create =
                        create_tab(&manager, &handle, format!("refused-{label}"), target, bounds(0));
                    refusals.insert(format!("create {label}"), create);
                }
                for (index, (label, url)) in loaded_tabs.iter().enumerate() {
                    create_tab(&manager, &handle, (*label).to_string(), url, bounds(index))
                        .expect("tab created");
                }
                let mut page_navigation_tried: Vec<&str> = Vec::new();
                let started = Instant::now();
                let mut quiet_since: Option<Instant> = None;
                loop {
                    std::thread::sleep(Duration::from_millis(400));
                    let mut outcomes = BTreeMap::new();
                    for label in &labels {
                        let webview = handle.get_webview(label);
                        if let Some(webview) = &webview {
                            let _ = webview.eval(PROBE);
                        }
                        let outcome = webview
                            .and_then(|webview| webview.url().ok())
                            .and_then(|url| outcome_from(&url));
                        outcomes.insert(label.clone(), outcome);
                    }
                    for (label, target) in &denied_targets {
                        let loaded = outcomes
                            .get(*label)
                            .and_then(Option::as_ref)
                            .is_some_and(|outcome| outcome.origin != "null");
                        if loaded && !page_navigation_tried.contains(label) {
                            let webview = handle.get_webview(label).expect("loaded tab");
                            let script = format!(
                                "location.href = {};",
                                serde_json::Value::String(format!("{target}?{PAGE_NAVIGATION}"))
                            );
                            let _ = webview.eval(&script);
                            let api = manager.navigate(label, target.clone());
                            refusals.insert(format!("navigate {label}"), api);
                            page_navigation_tried.push(label);
                            quiet_since = None;
                        }
                    }
                    let loaded = outcomes
                        .values()
                        .flatten()
                        .filter(|outcome| outcome.origin != "null")
                        .count();
                    *sink.lock().unwrap() = outcomes;
                    if loaded == labels.len() && page_navigation_tried.len() == denied_targets.len()
                    {
                        let since = *quiet_since.get_or_insert_with(Instant::now);
                        if since.elapsed() > SETTLE {
                            break;
                        }
                    }
                    if started.elapsed() > DEADLINE {
                        break;
                    }
                }
                *refused_sink.lock().unwrap() = refusals;
                handle.exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("fixture app builds");
    let profile_dir = app.path().app_local_data_dir().ok();
    app.run_return(|_, _| {});
    if let Some(dir) = profile_dir {
        std::thread::sleep(Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(dir);
    }

    let outcomes = collected.lock().unwrap().clone();
    let refused = refused.lock().unwrap().clone();
    let requests = |log: &Arc<Mutex<Vec<String>>>| log.lock().unwrap().clone();
    Report {
        outcomes,
        refused,
        app_command_runs: runs.count(),
        remote_requests: requests(&remote_requests),
        dev_requests: requests(&dev_requests),
        owned_requests: requests(&owned_requests),
        remote_origin,
        dev_origin,
    }
}

fn rejected_at(origin: &str, agentation: bool) -> Option<ProbeOutcome> {
    Some(ProbeOutcome {
        origin: origin.to_string(),
        internals: true,
        agentation,
        app: "rejected".to_string(),
        plugin: "rejected".to_string(),
    })
}

#[test]
#[ignore = "needs a display and a webview runtime; see the module docs"]
fn tabs_invoke_no_command_and_never_load_termul_origins() {
    let report = run();
    eprintln!("perimeter engine fixture report: {report:#?}");
    let outcome = |label: &str| report.outcomes.get(label).cloned().flatten();

    let main_origin = if tauri::is_dev() {
        report.dev_origin.clone()
    } else {
        app_origin().to_string()
    };
    assert_eq!(
        outcome("main"),
        Some(ProbeOutcome {
            origin: main_origin,
            internals: true,
            agentation: false,
            app: "resolved".to_string(),
            plugin: "resolved".to_string(),
        }),
        "control: the main webview reaches both commands"
    );
    assert_eq!(
        report.app_command_runs, 1,
        "only the main webview ran the app command"
    );

    assert_eq!(
        outcome("agent-remote"),
        rejected_at(&report.remote_origin, false)
    );
    assert_eq!(
        outcome("tab-user-remote"),
        rejected_at(&report.remote_origin, true)
    );
    assert_eq!(
        outcome("bypass-dev-origin"),
        rejected_at(&report.dev_origin, false)
    );
    assert_eq!(
        outcome("bypass-app-origin"),
        rejected_at(app_origin(), false)
    );

    // A release build has no dev server, so its origin is an ordinary
    // loopback page there: reachable, and still without commands.
    let denied = |label: &str| tauri::is_dev() || !label.ends_with("-dev-origin");
    for target in [
        "agent-to-dev-origin",
        "tab-user-to-dev-origin",
        "agent-to-app-origin",
        "agent-to-owned-port",
        "agent-to-unspecified",
        "agent-to-metadata",
    ] {
        let expected_origin = if denied(target) {
            &report.remote_origin
        } else {
            &report.dev_origin
        };
        assert_eq!(
            outcome(target),
            rejected_at(expected_origin, target.starts_with("tab-user")),
            "{target} after navigating itself"
        );
    }
    assert_eq!(
        report.refused.len(),
        12,
        "every create and navigate was tried"
    );
    for (attempt, result) in &report.refused {
        let target = attempt.split_once(' ').map_or("", |(_, target)| target);
        if denied(target) {
            assert!(
                result
                    .as_ref()
                    .is_err_and(|error| error.starts_with("navigation target not allowed")),
                "{attempt}: {result:?}"
            );
        } else {
            assert_eq!(result, &Ok(()), "{attempt}");
        }
    }
    assert!(
        !report.remote_requests.is_empty(),
        "the remote pages were served"
    );
    assert!(
        !report.dev_requests.is_empty(),
        "the dev-origin page was served to the bypass tab"
    );
    // WebView2 sends the request of a page-initiated navigation before the
    // navigation hook cancels it, so only those may reach the owned port; the
    // response never commits (asserted above).
    let leaked: Vec<&String> = report
        .owned_requests
        .iter()
        .filter(|target| !target.ends_with(PAGE_NAVIGATION))
        .collect();
    assert_eq!(
        leaked,
        Vec::<&String>::new(),
        "termul's own loads never reach the owned port"
    );
}
