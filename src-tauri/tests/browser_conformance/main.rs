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
#[path = "../browser_fixtures/server.rs"]
mod fixture_server;
mod report;

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

#[tauri::command]
async fn browser_agent_eval_result(
    tab_id: String,
    nonce: String,
    ok: bool,
    value: Option<String>,
    webview: tauri::Webview,
) -> Result<(), String> {
    if webview.label() != tab_id {
        return Err(format!("caller {} is not tab {tab_id}", webview.label()));
    }
    termul_manager_lib::conformance_support::eval_resolved(&nonce, ok, value);
    Ok(())
}

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
    dev_port: Option<u16>,
    main_ready: Arc<AtomicBool>,
) -> i32 {
    let os = std::env::consts::OS;
    let known = expected::parse(expected_for(os), cases::CAPABILITIES)
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
    for capability in cases::CAPABILITIES {
        let outcome = cases::run(&engine, &fixtures, capability).await;
        let verdict = judge(
            &Observed {
                capability,
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
    if std::env::var_os(ENABLE_VAR).is_none() {
        println!("browser_conformance: skipped, set {ENABLE_VAR}=1 to run it");
        return;
    }

    let mut context = tauri::generate_context!();
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
    println!(
        "fixtures on 127.0.0.1:{} (dev server port {:?})",
        fixtures.port(),
        dev_port
    );

    std::thread::spawn(|| {
        std::thread::sleep(WHOLE_RUN_BUDGET);
        die("whole-run budget exceeded");
    });

    let profile_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("browser-conformance-profile-{}", std::process::id()));
    let main_ready = Arc::new(AtomicBool::new(false));
    let ready_flag = main_ready.clone();
    let shell_url = fixtures.url("/");

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![browser_agent_eval_result])
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
                let code = tauri::async_runtime::spawn(run_all(
                    handle.clone(),
                    fixtures,
                    dev_port,
                    main_ready,
                ))
                .await
                .unwrap_or_else(|e| {
                    eprintln!("browser_conformance: runner panicked: {e}");
                    EXIT_HARNESS
                });
                handle.exit(code);
            });
            Ok(())
        })
        .build(context)
        .unwrap_or_else(|e| die(&format!("tauri build: {e}")));

    app.run(|_, _| {});
}
