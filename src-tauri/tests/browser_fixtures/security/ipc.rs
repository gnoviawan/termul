use std::sync::Arc;

use tauri::ipc::InvokeResponse;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{
    App, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
    WebviewWindowBuilder,
};

use super::ProbeRuns;
use crate::host_perimeter::main_webview_only;

const DEV_ORIGIN: &str = "http://localhost:5180/tauri-index.html";
const REMOTE_ORIGIN: &str = "https://example.com/";
const APP_COMMAND: &str = "perimeter_probe";
const PLUGIN_COMMAND: &str = "plugin:os|locale";

fn app_protocol_origin() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}

fn app(runs: Arc<ProbeRuns>) -> App<MockRuntime> {
    let app = mock_builder()
        .plugin(tauri_plugin_os::init())
        .manage(runs)
        .invoke_handler(main_webview_only(tauri::generate_handler![
            super::perimeter_probe
        ]))
        .build(crate::app_context())
        .expect("mock app builds with the real config and capabilities");
    WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("main window");
    app
}

fn tab(app: &App<MockRuntime>, label: &str) -> Webview<MockRuntime> {
    app.get_window("main")
        .expect("main window")
        .add_child(
            WebviewBuilder::new(label, WebviewUrl::External(REMOTE_ORIGIN.parse().unwrap())),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(100.0, 100.0),
        )
        .expect("tab webview")
}

/// `tauri::test::get_ipc_response` only accepts window webviews; tabs are
/// child webviews, so this sends the request the same way.
fn invoke(webview: &Webview<MockRuntime>, cmd: &str, origin: &str) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview.clone().on_message(
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            let _ = tx.send(response);
        }),
    );
    match rx.recv().expect("IPC response") {
        InvokeResponse::Ok(_) => Ok(()),
        InvokeResponse::Err(error) => Err(error.0.to_string()),
    }
}

#[test]
fn main_webview_reaches_app_and_plugin_commands() {
    let runs = Arc::new(ProbeRuns::default());
    let app = app(runs.clone());
    let main = app.get_webview("main").expect("main webview");

    assert_eq!(invoke(&main, APP_COMMAND, app_protocol_origin()), Ok(()));
    assert_eq!(invoke(&main, PLUGIN_COMMAND, app_protocol_origin()), Ok(()));
    assert_eq!(runs.count(), 1);
}

#[test]
fn tab_webviews_reach_no_command_from_any_origin() {
    let runs = Arc::new(ProbeRuns::default());
    let app = app(runs.clone());
    let tabs = [
        tab(&app, "agent-3f1c2a"),
        tab(&app, "6f7e2b9c-user-tab"),
        tab(&app, "terminal-link-browser-1"),
    ];
    let origins = [
        DEV_ORIGIN,
        app_protocol_origin(),
        REMOTE_ORIGIN,
        "http://127.0.0.1:5191/",
    ];

    // Tauri runs its ACL for app commands only on remote origins. From the
    // origins it treats as local, the label guard is what stops them.
    let local =
        |origin: &str| origin == app_protocol_origin() || (tauri::is_dev() && origin == DEV_ORIGIN);
    for tab in &tabs {
        for origin in origins {
            let app_command = invoke(tab, APP_COMMAND, origin);
            if local(origin) {
                assert_eq!(
                    app_command,
                    Err("\"command not allowed from this webview\"".to_string()),
                    "app command from {} at {origin}",
                    tab.label()
                );
            } else {
                assert!(
                    app_command
                        .as_ref()
                        .is_err_and(|error| error.contains("not allowed")),
                    "app command from {} at {origin}: {app_command:?}",
                    tab.label()
                );
            }
            let plugin = invoke(tab, PLUGIN_COMMAND, origin);
            assert!(
                plugin
                    .as_ref()
                    .is_err_and(|error| error.contains("not allowed")),
                "plugin command from {} at {origin}: {plugin:?}",
                tab.label()
            );
        }
    }
    assert_eq!(runs.count(), 0);
}
