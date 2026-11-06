//! Browser automation conformance runner.
//!
//! Boots a real Tauri app with a real webview, serves the fixture pages from
//! a loopback port, and drives the automation host through its public entry
//! point. Prints a per-capability table and writes a JSON summary. The exit
//! code is non-zero when a result differs from the per-OS expected file.
//!
//! Skips unless `TERMUL_BROWSER_CONFORMANCE` is set, so plain `cargo test`
//! stays headless. `TERMUL_BROWSER_CONFORMANCE_OUT` overrides the summary path.

mod adapter;
mod cases;
mod expected;
mod input_cases;
#[path = "../browser_fixtures/server.rs"]
mod fixture_server;
mod host_log;
mod profile;
mod report;
mod sensitive_cases;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

use expected::{judge, Observed, Verdict};
use fixture_server::FixtureServer;
use report::Row;

const ENABLE_VAR: &str = "TERMUL_BROWSER_CONFORMANCE";
const OUT_VAR: &str = "TERMUL_BROWSER_CONFORMANCE_OUT";
const WHOLE_RUN_BUDGET: Duration = Duration::from_secs(15 * 60);
const MAIN_WEBVIEW_READY_BUDGET: Duration = Duration::from_secs(20);
const EXIT_UNEXPECTED: i32 = 1;
const EXIT_HARNESS: i32 = 2;

/// WebView2 gets a fake camera and microphone, so a machine with a real but
/// unresponsive capture device still reaches the host's permission handler.
/// On GitHub's Windows image `enumerateDevices` stays empty with the switch
/// set; that runner has no device and the permissions case accepts it. Only
/// the device switch: the UI switch would auto-allow the prompt.
const FAKE_DEVICE_SWITCH: &str = "--use-fake-device-for-media-stream";
const WEBVIEW2_ARGS_VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

fn expected_for(os: &str) -> &'static str {
    match os {
        "windows" => include_str!("expected/windows.json"),
        "macos" => include_str!("expected/macos.json"),
        _ => include_str!("expected/linux.json"),
    }
}

fn summary_path() -> PathBuf {
    std::env::var_os(OUT_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("browser-conformance.json")
        })
}

fn die(message: &str) -> ! {
    eprintln!("browser_conformance: {message}");
    std::process::exit(EXIT_HARNESS);
}

async fn run_all(
    handle: tauri::AppHandle,
    fixtures: Arc<FixtureServer>,
    cross: Arc<FixtureServer>,
    dev_port: Option<u16>,
    main_ready: Arc<AtomicBool>,
) -> i32 {
    let os = std::env::consts::OS;
    let known = expected::parse(expected_for(os), &cases::ids())
        .unwrap_or_else(|e| die(&format!("expected file for {os}: {e}")));
    if Some(fixtures.port()) == dev_port {
        die("fixture port equals the dev server port");
    }

    let waited = std::time::Instant::now();
    while !main_ready.load(Ordering::SeqCst) && waited.elapsed() < MAIN_WEBVIEW_READY_BUDGET {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !main_ready.load(Ordering::SeqCst) {
        eprintln!("browser_conformance: main webview never reported a page load, continuing");
    }

    let engine = adapter::Engine::install(&handle);
    let mut rows = Vec::new();
    let mut broken: Vec<&'static str> = Vec::new();
    for capability in cases::CAPABILITIES {
        let outcome = cases::run(&engine, &fixtures, &cross, capability, &broken).await;
        if outcome.failure.is_some() {
            broken.push(capability.id);
        }
        let verdict = judge(
            &Observed {
                capability: capability.id,
                failure_code: outcome.failure.as_ref().map(|f| f.code.as_str()),
            },
            &known,
        );
        rows.push(Row { outcome, verdict });
    }

    report::print_table(os, &rows);
    let summary = report::summary_json(os, fixtures.port(), dev_port, &rows);
    let path = summary_path();
    match serde_json::to_string_pretty(&summary)
        .map_err(|e| e.to_string())
        .and_then(|text| std::fs::write(&path, text).map_err(|e| e.to_string()))
    {
        Ok(()) => println!("summary written to {}", path.display()),
        Err(e) => eprintln!("browser_conformance: could not write summary: {e}"),
    }
    println!("summary json: {summary}");

    if rows
        .iter()
        .any(|r| matches!(r.verdict, Verdict::Unexpected(_)))
    {
        EXIT_UNEXPECTED
    } else {
        0
    }
}

fn main() {
    let mut context = tauri::generate_context!();
    if std::env::var_os(profile::ENABLE_VAR).is_some() {
        profile::main(context);
        return;
    }
    if std::env::var_os(ENABLE_VAR).is_none() {
        println!("browser_conformance: skipped, set {ENABLE_VAR}=1 to run it");
        return;
    }

    host_log::install();
    if cfg!(windows) {
        let args = match std::env::var(WEBVIEW2_ARGS_VAR) {
            Ok(existing) if !existing.is_empty() => format!("{existing} {FAKE_DEVICE_SWITCH}"),
            _ => FAKE_DEVICE_SWITCH.to_string(),
        };
        std::env::set_var(WEBVIEW2_ARGS_VAR, args);
    }
    // Keeps the webview profile and app data apart from an installed app.
    context.config_mut().identifier = "com.termul-manager.conformance".to_string();
    context.config_mut().app.windows.clear();
    let dev_port = context
        .config()
        .build
        .dev_url
        .as_ref()
        .and_then(|url| url.port());

    let avoid: Vec<u16> = dev_port.into_iter().collect();
    let fixtures = Arc::new(
        FixtureServer::start(&avoid).unwrap_or_else(|e| die(&format!("fixture server: {e}"))),
    );
    let avoid: Vec<u16> = avoid.into_iter().chain([fixtures.port()]).collect();
    let cross = Arc::new(
        FixtureServer::start(&avoid).unwrap_or_else(|e| die(&format!("cross-origin fixture server: {e}"))),
    );
    println!(
        "fixtures on 127.0.0.1:{} and :{} (dev server port {:?})",
        fixtures.port(),
        cross.port(),
        dev_port
    );

    std::thread::spawn(|| {
        std::thread::sleep(WHOLE_RUN_BUDGET);
        die("whole-run budget exceeded");
    });

    let profile_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "browser-conformance-profile-{}",
        std::process::id()
    ));
    let main_ready = Arc::new(AtomicBool::new(false));
    let ready_flag = main_ready.clone();
    let shell_url = fixtures.url("/chat.html");

    let app = tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(shell_url.parse()?))
                .title("Browser conformance")
                .inner_size(1200.0, 800.0)
                .data_directory(profile_dir)
                .on_page_load(move |_, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        ready_flag.store(true, Ordering::SeqCst);
                    }
                })
                .build()?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let code =
                    tauri::async_runtime::spawn(run_all(handle, fixtures, cross, dev_port, main_ready))
                        .await
                        .unwrap_or_else(|e| {
                            eprintln!("browser_conformance: runner panicked: {e}");
                            EXIT_HARNESS
                        });
                // `AppHandle::exit` did not carry the code out of the process on
                // Linux, so leave directly once the summary is written.
                std::process::exit(code);
            });
            Ok(())
        })
        .build(context)
        .unwrap_or_else(|e| die(&format!("tauri build: {e}")));

    app.run(|_, _| {});
}
