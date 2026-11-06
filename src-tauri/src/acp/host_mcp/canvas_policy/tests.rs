use serde_json::json;

use super::*;

fn execute(command: &str, params: Value) -> Value {
    json!({ "command": command, "params": params })
}

fn refused(route: &CanvasRoute) -> bool {
    matches!(route, CanvasRoute::Refuse(error) if error.code == CanvasErrorCode::UnsupportedInKiosk)
}

/// Every command the pinned engine runs: `{id, label, params, ...}`, where
/// `params` documents its parameters for agents.
fn engine_specs() -> Vec<Value> {
    use figcraft_mcp::Backend as _;
    let listed = figcraft_mcp::Headless::new()
        .call("engine.commands", json!({}))
        .unwrap();
    listed.as_array().unwrap().clone()
}

/// The id of every command the pinned engine runs.
fn engine_commands() -> std::collections::BTreeSet<String> {
    engine_specs()
        .iter()
        .filter_map(|command| command["id"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn editing_and_reading_methods_go_to_the_editor() {
    for (method, params) in [
        (
            "engine.execute",
            execute(
                "node.create",
                json!({"type": "vector", "path": "M0 0 L1 1"}),
            ),
        ),
        (
            "engine.execute",
            execute("proto.action.set", json!({"path": [0, 1, 2]})),
        ),
        (
            "engine.execute",
            execute("file.export", json!({"format": "png"})),
        ),
        (
            "engine.execute",
            execute("image.place", json!({"data": "AAAA"})),
        ),
        (
            "engine.execute",
            execute("variable.import", json!({"variables": "{\"a\":1}"})),
        ),
        ("node.get", json!({"id": 1})),
        ("host.renderPng", json!({"scale": 1})),
        ("ui.screenshot", json!({})),
        ("ui.pointer", json!({"x": 1, "y": 2})),
    ] {
        assert_eq!(
            route(method, &params),
            CanvasRoute::Forward,
            "{method} {params}"
        );
    }
}

/// Commands that change or read only the document, the view or the
/// editor's own preferences.
#[test]
fn document_view_and_preference_commands_go_to_the_editor() {
    for command in [
        "node.find",
        "image.crop",
        "layout.removeAll",
        "variable.extendCollection",
        "text.wrapStyle",
        "comment.prompt",
        "file.fontReport",
        "font.downloads",
        "board.addConnected",
        "board.reshape",
        "board.grid",
        "widget.hover",
        "view.minimize",
        "pref.uiScaleUp",
        "pref.uiScaleDown",
        "pref.uiScaleReset",
        "pref.scrollWheelZoom",
    ] {
        assert_eq!(
            route("engine.execute", &execute(command, json!({}))),
            CanvasRoute::Forward,
            "{command}"
        );
    }
}

#[test]
fn save_is_the_host_save_whatever_path_it_names() {
    for params in [json!({}), json!({"path": "C:/elsewhere/doc.figcraft"})] {
        assert_eq!(
            route("engine.execute", &execute("file.save", params)),
            CanvasRoute::HostSave
        );
    }
}

fn export_to(command: &str, params: Value) -> (String, Value) {
    let CanvasRoute::ExportTo { path, execute } =
        route("engine.execute", &execute(command, params))
    else {
        panic!("{command} with a path is written by Termul");
    };
    (path, execute)
}

#[test]
fn an_export_with_a_path_runs_without_it_and_keeps_its_options() {
    for command in ["file.exportSvg", "file.exportFramesPdf"] {
        let params =
            json!({"path": "out/a.pdf", "ids": [18_446_744_073_709_551_615u64], "cmyk": true});
        let (path, stripped) = export_to(command, params);
        assert_eq!(path, "out/a.pdf");
        assert_eq!(
            stripped,
            execute(
                command,
                json!({"ids": [18_446_744_073_709_551_615u64], "cmyk": true})
            )
        );
    }
    let (path, stripped) = export_to(
        "file.export",
        json!({"path": "out/a.pdf", "ids": [18_446_744_073_709_551_615u64], "cmyk": true}),
    );
    assert_eq!(path, "out/a.pdf");
    assert_eq!(
        stripped,
        execute(
            "file.export",
            json!({"ids": [18_446_744_073_709_551_615u64], "cmyk": true, "format": "pdf"})
        ),
        "the format the path's extension named, which the editor no longer sees"
    );
}

#[test]
fn an_export_without_a_format_takes_it_from_the_paths_extension() {
    for (requested, format) in [
        ("assets/logo.svg", "svg"),
        ("out/deck.PDF", "pdf"),
        ("hero.jpeg", "jpg"),
        ("hero.jpg", "jpg"),
        ("thumb.webp", "webp"),
        ("shot.png", "png"),
        ("design.fig", "fig"),
        ("res/drawable/ic_logo.XML", "xml"),
    ] {
        let (_, stripped) = export_to("file.export", json!({"path": requested}));
        assert_eq!(stripped["params"], json!({"format": format}), "{requested}");
    }
    let (_, stripped) = export_to("file.export", json!({"path": "a.png", "format": "svg"}));
    assert_eq!(
        stripped["params"],
        json!({"format": "svg"}),
        "an explicit format stands"
    );
}

#[test]
fn an_export_path_with_no_known_extension_and_no_format_is_refused() {
    for requested in ["notes.txt", "out/logo", "archive.tar.gz"] {
        let route = route(
            "engine.execute",
            &execute("file.export", json!({"path": requested})),
        );
        let CanvasRoute::Refuse(error) = route else {
            panic!("{requested}: the format cannot be told");
        };
        assert!(
            error.message.contains("format"),
            "{requested}: {}",
            error.message
        );
    }
}

#[test]
fn commands_and_methods_that_name_files_are_unsupported_in_kiosk() {
    let cases = [
        (
            "engine.execute",
            execute("file.open", json!({"path": "a.figcraft"})),
        ),
        (
            "engine.execute",
            execute("file.open", json!({"data": "AAAA", "name": "a.png"})),
        ),
        (
            "engine.execute",
            execute("file.saveAs", json!({"path": "a.figcraft"})),
        ),
        ("engine.execute", execute("file.openRecent", json!({}))),
        (
            "engine.execute",
            execute("file.recover", json!({"path": "a"})),
        ),
        ("engine.execute", execute("file.revert", json!({}))),
        (
            "engine.execute",
            execute("library.add", json!({"path": "lib.figcraft"})),
        ),
        ("engine.execute", execute("window.new", json!({}))),
        (
            "engine.execute",
            execute("file.exportLayers", json!({"dir": "out"})),
        ),
        (
            "engine.execute",
            execute("file.import", json!({"path": "a.svg"})),
        ),
        (
            "engine.execute",
            execute(
                "file.import",
                json!({"data": "AAAA", "variables": "vars.json"}),
            ),
        ),
        (
            "engine.execute",
            execute("file.placeImage", json!({"path": "a.png"})),
        ),
        (
            "engine.execute",
            execute("image.place", json!({"path": "a.png"})),
        ),
        (
            "engine.execute",
            execute("variable.export", json!({"path": "v.json"})),
        ),
        (
            "engine.execute",
            execute("variable.import", json!({"variables": "v.json"})),
        ),
        ("ui.render", json!({"path": "shot.png"})),
        ("ui.screenshot", json!({"path": "shot.png"})),
    ];
    for (method, params) in cases {
        assert!(refused(&route(method, &params)), "{method} {params}");
    }
}

fn refusal(method: &str, params: &Value) -> CanvasError {
    match route(method, params) {
        CanvasRoute::Refuse(error) if error.code == CanvasErrorCode::UnsupportedInKiosk => error,
        other => panic!("{method} {params} is refused, not {other:?}"),
    }
}

#[test]
fn a_command_that_names_a_file_is_refused_and_its_inline_form_goes_to_the_editor() {
    for (command, with_file, inline, instead) in [
        (
            "text.loadFont",
            json!({"path": "fonts/Brand.ttf"}),
            json!({"data": "AAAA"}),
            "`data`",
        ),
        (
            "data.fill",
            json!({"id": 4, "rows": [], "dir": "out"}),
            json!({"id": 4, "rows": []}),
            "`dir`",
        ),
        (
            "component.playground",
            json!({"id": 4, "path": "preview.png"}),
            json!({"id": 4}),
            "`path`",
        ),
        (
            "codeConnect.export",
            json!({"path": "figcraft.connect.json"}),
            json!({}),
            "`path`",
        ),
        (
            "codeConnect.import",
            json!({"path": "figcraft.connect.json"}),
            json!({"json": {"version": 1, "links": []}}),
            "`json`",
        ),
        (
            "image.replace",
            json!({"ids": [4], "path": "brand/logo.png"}),
            json!({"ids": [4], "data": "AAAA"}),
            "`data`",
        ),
    ] {
        let error = refusal("engine.execute", &execute(command, with_file));
        assert!(
            error.message.contains("reads or writes files") && error.message.contains(instead),
            "{command}: {}",
            error.message
        );
        assert_eq!(
            route("engine.execute", &execute(command, inline.clone())),
            CanvasRoute::Forward,
            "{command} {inline}"
        );
    }
}

#[test]
fn a_command_that_opens_closes_or_switches_documents_is_refused() {
    for command in [
        "file.new",
        "file.newBoard",
        "file.newFromTemplate",
        "file.duplicate",
        "file.close",
        "version.duplicate",
        "branch.create",
        "branch.open",
        "doc.switch",
        "doc.nextTab",
        "doc.previousTab",
        "collab.join",
        "collab.openFile",
        "collab.recoverFile",
        "window.new",
    ] {
        let error = refusal("engine.execute", &execute(command, json!({"index": 0})));
        assert!(
            error.message.contains("switches documents"),
            "{command}: {}",
            error.message
        );
    }
}

#[test]
fn marking_the_document_saved_without_saving_is_refused() {
    let error = refusal("engine.execute", &execute("file.markSaved", json!({})));
    assert!(
        error.message.contains("without saving") && error.message.contains("save_file"),
        "{}",
        error.message
    );
}

#[test]
fn sending_the_document_outside_termul_is_refused() {
    for command in [
        "library.publishToServer",
        "collab.host",
        "collab.publish",
        "collab.share",
    ] {
        let error = refusal("engine.execute", &execute(command, json!({})));
        assert!(
            error.message.contains("outside Termul"),
            "{command}: {}",
            error.message
        );
    }
}

#[test]
fn opening_links_and_reaching_servers_or_the_machine_outside_termul_is_refused() {
    assert_eq!(
        refusal("engine.execute", &execute("text.openLink", json!({}))).message,
        "`text.openLink` opens a link in a web browser, which the Termul canvas does not allow"
    );
    for (command, params, does) in [
        (
            "library.check",
            json!({"library": "Brand"}),
            "contacts the servers of the document's team libraries",
        ),
        (
            "font.download",
            json!({"family": "Inter"}),
            "downloads a font family and installs it into this machine's shared font folder",
        ),
    ] {
        let error = refusal("engine.execute", &execute(command, params));
        assert!(
            error.message.starts_with(&format!("`{command}` {does}"))
                && error
                    .message
                    .ends_with("which the Termul canvas does not allow"),
            "{command}: {}",
            error.message
        );
    }
}

/// Commands that install, update or publish plugin code. A plugin's code
/// runs on this machine, so an agent may not bring new code in, whether from
/// a plugin directory or as bytes it passes itself.
const PLUGIN_CODE: &[(&str, &str)] = &[
    (
        "plugin.directory.install",
        r#"{"id": "x.y", "confirm": true, "server": "ws://host:47900/"}"#,
    ),
    ("plugin.import", r#"{"manifest": {}, "wasm": "AAAA"}"#),
    ("plugin.import", r#"{"path": "plugins/hello"}"#),
    (
        "plugin.directory.publish",
        r#"{"plugin": "x.y", "server": "ws://host:47900/?key=k"}"#,
    ),
    (
        "plugin.directory.unpublish",
        r#"{"id": "x.y", "server": "ws://host:47900/?key=k"}"#,
    ),
];

/// `plugin.*` and `plugins.*` commands that bring in no code: listing, and
/// running, using or closing a plugin that is already installed.
const PLUGIN_KEPT: &[(&str, &str)] = &[
    ("plugin.list", "{}"),
    ("plugin.run", r#"{"id": "x.y"}"#),
    ("plugin.ui", "{}"),
    ("plugin.event", r#"{"id": "x.y", "control": "go"}"#),
    ("plugin.close", r#"{"id": "x.y"}"#),
    ("plugin.remove", r#"{"id": "x.y"}"#),
    ("plugins.runLast", "{}"),
    ("plugins.manage", "{}"),
];

#[test]
fn installing_or_publishing_plugin_code_is_refused_and_installed_plugins_still_run() {
    for (command, params) in PLUGIN_CODE {
        let params: Value = serde_json::from_str(params).unwrap();
        let error = refusal("engine.execute", &execute(command, params));
        assert!(
            error.message.contains("plugin code") && error.message.contains("agent canvas tools"),
            "{command}: {}",
            error.message
        );
    }
    for (command, params) in PLUGIN_KEPT {
        let params: Value = serde_json::from_str(params).unwrap();
        assert_eq!(
            route("engine.execute", &execute(command, params.clone())),
            CanvasRoute::Forward,
            "{command} {params}"
        );
    }
}

/// A plugin command the engine adds must be sorted into one of the lists
/// above before it reaches the editor unchecked.
#[test]
fn every_plugin_command_the_pinned_engine_runs_is_refused_or_known_to_bring_in_no_code() {
    let commands = engine_commands();
    let engine: Vec<&str> = commands
        .iter()
        .map(String::as_str)
        .filter(|id| id.starts_with("plugin.") || id.starts_with("plugins."))
        .collect();
    let mut sorted: Vec<&str> = PLUGIN_CODE
        .iter()
        .chain(PLUGIN_KEPT)
        .map(|(command, _)| *command)
        .chain(
            REACHES_A_SERVER
                .iter()
                .map(|(command, ..)| *command)
                .filter(|command| command.starts_with("plugin.")),
        )
        .collect();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(engine, sorted);
}

const SESSIONS: &str = "is for live sessions and files kept on a sharing server outside Termul";
const LIBRARIES: &str = "loads the document's linked libraries, which contacts the servers of its \
                         team libraries and reads library files outside the project";

/// Commands that make the editor contact a server, set the server it
/// contacts, or open a page outside Termul, each with what its refusal says
/// it does.
const REACHES_A_SERVER: &[(&str, &str, &str)] = &[
    (
        "pref.publishServer",
        r#"{"url": "ws://127.0.0.1:9/agent-chosen-path/"}"#,
        "sets the sharing server the editor contacts for online files and join codes",
    ),
    ("collab.files", r#"{"refresh": true}"#, SESSIONS),
    ("collab.files", "{}", SESSIONS),
    (
        "collab.serverInfo",
        r#"{"server": "ws://127.0.0.1:9/"}"#,
        SESSIONS,
    ),
    (
        "collab.manageFile",
        r#"{"file": "f", "server": "ws://127.0.0.1:9/", "owner": "o", "action": "links"}"#,
        SESSIONS,
    ),
    ("collab.removePerson", r#"{"client": 2}"#, SESSIONS),
    ("collab.report", r#"{"reason": "spam"}"#, SESSIONS),
    ("collab.stop", "{}", SESSIONS),
    ("collab.leave", "{}", SESSIONS),
    ("collab.peers", "{}", SESSIONS),
    ("collab.diff", "{}", SESSIONS),
    ("collab.forgetFile", r#"{"file": "f"}"#, SESSIONS),
    ("collab.follow", "{}", SESSIONS),
    ("collab.cursor", r#"{"x": 1, "y": 2}"#, SESSIONS),
    ("collab.cursorChat", r#"{"text": "hi"}"#, SESSIONS),
    ("collab.spotlight", "{}", SESSIONS),
    (
        "collab.registerLinks",
        r#"{"on": true}"#,
        "makes this app the opener of figcraft:// invite links on this machine",
    ),
    (
        "plugin.directory.list",
        r#"{"server": "ws://127.0.0.1:9/"}"#,
        "asks a plugin directory server for its plugins",
    ),
    (
        "help.page",
        "{}",
        "opens FigCraft's help page in a web browser",
    ),
    ("library.list", r#"{"assets": true}"#, LIBRARIES),
    ("library.updates", "{}", LIBRARIES),
    ("library.usage", r#"{"library": "Brand"}"#, LIBRARIES),
    ("library.acceptUpdates", "{}", LIBRARIES),
    (
        "library.place",
        r#"{"library": "Brand", "component": "Button"}"#,
        LIBRARIES,
    ),
    (
        "library.import",
        r#"{"library": "Brand", "component": "Button"}"#,
        LIBRARIES,
    ),
    (
        "library.swap",
        r#"{"from": "Brand", "to": "Brand 2"}"#,
        LIBRARIES,
    ),
    (
        "library.swapAt",
        r#"{"library": "Brand", "component": "Button"}"#,
        LIBRARIES,
    ),
    (
        "library.applyStyle",
        r#"{"library": "Brand", "style": "Primary"}"#,
        LIBRARIES,
    ),
    (
        "library.importVariable",
        r#"{"library": "Brand", "variable": "space/1"}"#,
        LIBRARIES,
    ),
    (
        "library.bindVariable",
        r#"{"library": "Brand", "variable": "space/1"}"#,
        LIBRARIES,
    ),
    (
        "library.aliasVariable",
        r#"{"library": "Brand", "variable": "gap", "alias": "space/1"}"#,
        LIBRARIES,
    ),
    (
        "library.setVariableMode",
        r#"{"library": "Brand", "collection": "Theme"}"#,
        LIBRARIES,
    ),
    (
        "library.extendCollection",
        r#"{"library": "Brand", "collection": "Theme"}"#,
        LIBRARIES,
    ),
];

#[test]
fn reaching_a_server_or_choosing_the_server_the_editor_contacts_is_refused() {
    for (command, params, does) in REACHES_A_SERVER {
        let params: Value = serde_json::from_str(params).unwrap();
        assert_eq!(
            refusal("engine.execute", &execute(command, params.clone())).message,
            format!("`{command}` {does}, which the Termul canvas does not allow"),
            "{command} {params}"
        );
    }
}

/// A listener standing in for a server the agent chose, and its WebSocket URL.
fn agents_server() -> (std::net::TcpListener, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("ws://{}/agent-chosen-path/", listener.local_addr().unwrap());
    (listener, url)
}

/// The request the editor sent the agent's server within a second, if any.
fn request_received(listener: &std::net::TcpListener) -> Option<String> {
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok((mut stream, _)) = listener.accept() {
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                .unwrap();
            let mut request = [0u8; 256];
            let read = std::io::Read::read(&mut stream, &mut request).unwrap_or(0);
            return Some(String::from_utf8_lossy(&request[..read]).into_owned());
        }
    }
    None
}

/// Send `call` the way the gateway does: a forwarded call reaches the
/// editor, and a refused one answers its message.
fn send(editor: &mut figcraft_mcp::Headless, call: Value) -> Option<String> {
    use figcraft_mcp::Backend as _;
    match route("engine.execute", &call) {
        CanvasRoute::Forward => {
            let _ = editor.call("engine.execute", call);
            None
        }
        CanvasRoute::Refuse(error) => Some(error.message),
        other => panic!("{call}: {other:?}"),
    }
}

/// The figcraft audit's probe, sent through the policy the way the gateway
/// sends calls: an agent points the editor's sharing server at a listener and
/// asks it to refresh the online files, which made the engine open a
/// WebSocket to the agent's path. Headless installs the engine's network
/// link, so a forwarded call would really connect.
#[test]
fn an_agent_cannot_point_the_editor_at_its_own_server_and_make_it_connect() {
    let (listener, url) = agents_server();
    let mut editor = figcraft_mcp::Headless::new();
    let refusals = [
        send(
            &mut editor,
            execute("pref.publishServer", json!({"url": url})),
        ),
        send(
            &mut editor,
            execute("collab.files", json!({"refresh": true})),
        ),
    ];
    assert_eq!(request_received(&listener), None);
    assert_eq!(
        refusals,
        [
            Some(
                "`pref.publishServer` sets the sharing server the editor contacts for online \
                 files and join codes, which the Termul canvas does not allow"
                    .to_string()
            ),
            Some(
                "`collab.files` is for live sessions and files kept on a sharing server outside \
                 Termul, which the Termul canvas does not allow"
                    .to_string()
            ),
        ]
    );
}

/// An editor showing a document that links the team library "Brand" on
/// `url`, as a document the user opened or cloned can.
fn editor_with_team_library(url: &str) -> figcraft_mcp::Headless {
    use base64::Engine as _;
    use figcraft_mcp::Backend as _;
    let base64 = base64::engine::general_purpose::STANDARD;
    let mut editor = figcraft_mcp::Headless::new();
    let saved = editor
        .call(
            "engine.execute",
            execute("file.saveAs", json!({"data": true})),
        )
        .unwrap();
    let saved = saved.get("result").unwrap_or(&saved);
    let bytes = base64.decode(saved["data"].as_str().unwrap()).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut linked = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut linked);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
        if name == "document.json" {
            let mut document: Value = serde_json::from_slice(&data).unwrap();
            document["libraries"] = json!({"enabled": [{
                "id": "lib-brand",
                "name": "Brand",
                "path": format!("{url}?file=brandfile&token=aaaaaaaaaaaaaaaaaaaaaaaa"),
                "version": 1
            }]});
            data = serde_json::to_vec(&document).unwrap();
        }
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, &data).unwrap();
    }
    writer.finish().unwrap();
    let data = base64.encode(linked.into_inner());
    editor
        .call(
            "engine.execute",
            execute(
                "file.open",
                json!({"data": data, "name": "design.figcraft"}),
            ),
        )
        .unwrap();
    editor
}

const BRAND_STYLE: &str = r#"{"library": "Brand", "style": "Primary"}"#;

/// The second audit's probe: `text.preview` runs the command it names, and
/// a preview of `library.applyStyle` made the editor load the document's
/// team library from the agent's server.
#[test]
fn previewing_a_team_library_style_cannot_make_the_editor_connect() {
    let (listener, url) = agents_server();
    let mut editor = editor_with_team_library(&url);
    assert_eq!(
        request_received(&listener),
        None,
        "opening contacts nothing"
    );
    let style: Value = serde_json::from_str(BRAND_STYLE).unwrap();
    let preview = execute(
        "text.preview",
        json!({"command": "library.applyStyle", "params": style}),
    );
    let refusals = [
        send(&mut editor, preview.clone()),
        send(
            &mut editor,
            execute("command.batch", json!({"commands": [preview]})),
        ),
    ];
    assert_eq!(request_received(&listener), None);
    let preview_refusal = "`text.preview` runs the command it previews: `library.applyStyle` \
                           loads the document's linked libraries, which contacts the servers of \
                           its team libraries and reads library files outside the project, which \
                           the Termul canvas does not allow";
    assert_eq!(
        refusals,
        [
            Some(preview_refusal.to_string()),
            Some(format!("batch step 0: {preview_refusal}")),
        ]
    );
}

/// A batch step's param can be a reference to an earlier step's result,
/// which the engine fills in after Termul checked the batch. The audit's
/// preview names its command that way, and an export takes its path that
/// way, so each is refused unread.
#[test]
fn a_batch_step_cannot_take_a_param_termul_checks_from_an_earlier_step() {
    let (listener, url) = agents_server();
    let mut editor = editor_with_team_library(&url);
    let outside = std::env::temp_dir().join(format!(
        "termul-canvas-reference-{}.svg",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&outside);
    // `proto.evaluate` answers `{value: {value}}` with the text the agent wrote.
    let named = |text: &str| {
        json!({"command": "proto.evaluate", "as": "named", "params": {
            "expression": format!("'{text}'")
        }})
    };
    let text_of_named = json!({"$ref": "named", "field": "value/value"});
    let preview = execute(
        "command.batch",
        json!({"commands": [
            named("library.applyStyle"),
            {"command": "text.preview", "params": {
                "command": text_of_named,
                "params": serde_json::from_str::<Value>(BRAND_STYLE).unwrap()
            }}
        ]}),
    );
    let export = execute(
        "command.batch",
        json!({"commands": [
            {"command": "node.create", "as": "frame", "params": {
                "type": "frame", "width": 10, "height": 10
            }},
            named(outside.to_str().unwrap()),
            {"command": "file.exportSvg", "params": {
                "ids": [{"$ref": "frame"}], "path": text_of_named
            }}
        ]}),
    );
    let refusals = [send(&mut editor, preview), send(&mut editor, export)];
    assert_eq!(request_received(&listener), None);
    assert!(!outside.exists(), "the editor wrote {}", outside.display());
    assert_eq!(
        refusals,
        [
            Some(
                "batch step 1: `text.preview` runs the command it previews: its `command` is \
                 taken from an earlier batch step, which Termul cannot check before the batch \
                 runs; name the command itself"
                    .to_string()
            ),
            Some(
                "batch step 2: `file.exportSvg` reads or writes files, which the Termul canvas \
                 does not allow: save_file saves the project's document, and export returns \
                 bytes or writes inside the project"
                    .to_string()
            ),
        ]
    );
}

/// The third audit's probe: a step stores a `library.applyStyle` call as a
/// widget's state, `widget.list` reads it back as JSON, and a `text.preview`
/// step takes its whole params from that, which made the editor load the
/// team library from the agent's server.
#[test]
fn a_batch_step_cannot_take_its_whole_params_from_an_earlier_step() {
    let (listener, url) = agents_server();
    let mut editor = editor_with_team_library(&url);
    let state = json!({
        "command": "library.applyStyle",
        "params": serde_json::from_str::<Value>(BRAND_STYLE).unwrap()
    });
    let batch = execute(
        "command.batch",
        json!({"commands": [
            {"command": "node.create", "as": "widget", "params": {
                "type": "frame", "width": 10, "height": 10
            }},
            {"command": "node.set", "params": {"ids": [{"$ref": "widget"}], "props": {
                "pluginData": {"figcraft.widget": "x.y", "figcraft.widget.state": state.to_string()}
            }}},
            {"command": "widget.list", "params": {}},
            {"command": "text.preview", "params": {"$step": 2, "field": "widgets/0/state"}}
        ]}),
    );
    let refusal = send(&mut editor, batch);
    assert_eq!(request_received(&listener), None);
    assert_eq!(
        refusal.as_deref(),
        Some(
            "batch step 3: `text.preview`'s params come from an earlier batch step, so Termul \
             cannot check them; pass them directly"
        )
    );
}

#[test]
fn every_command_whose_whole_params_come_from_an_earlier_step_is_refused() {
    let message = |route: CanvasRoute| match route {
        CanvasRoute::Refuse(error) if error.code == CanvasErrorCode::UnsupportedInKiosk => {
            error.message
        }
        other => format!("{other:?}"),
    };
    for command in engine_commands() {
        for reference in [
            json!({"$step": 0}),
            json!({"$ref": "first", "field": "ids"}),
            json!({"$name": "first"}),
        ] {
            let step = execute(&command, reference.clone());
            let preview = execute(
                "text.preview",
                json!({"command": command, "params": reference}),
            );
            let batch = |step: &Value| {
                execute(
                    "command.batch",
                    json!({"commands": [
                        {"command": "node.create", "as": "first", "params": {"type": "frame"}},
                        step
                    ]}),
                )
            };
            let unread = format!(
                "`{command}`'s params come from an earlier batch step, so Termul cannot check \
                 them; pass them directly"
            );
            assert_eq!(
                message(route("engine.execute", &batch(&step))),
                format!("batch step 1: {unread}"),
            );
            assert_eq!(
                message(route("engine.execute", &batch(&preview))),
                format!("batch step 1: `text.preview` runs the command it previews: {unread}"),
            );
        }
    }
}

/// Engine command families that reach servers or open links. The reviewed
/// command list only catches new ids, not an existing command that starts
/// contacting a server, so every command in these families is refused
/// unless it is listed in `CONTACTS_NO_SERVER`.
const SERVER_PREFIXES: &[&str] = &["collab.", "library.", "libraries.", "plugin.directory."];
const SERVER_WORDS: &[&str] = &[
    "server", "publish", "download", "upload", "share", "link", "url", "fetch", "online",
];

/// Commands in those families reviewed against the pinned engine to contact
/// no server and open nothing outside the canvas.
const CONTACTS_NO_SERVER: &[&str] = &[
    // Copies a comment's link.
    "comment.link",
    // Marks a layer to leave out of a published library.
    "component.hideWhenPublishing",
    // Lists this session's font downloads.
    "font.downloads",
    // Open the Libraries panel and its publish form.
    "libraries.open",
    "libraries.publish",
    // Publishes the document's library inside the document.
    "library.publish",
    // Removes a library link from the document.
    "library.remove",
    // Shows the prototype link notice again.
    "proto.linkNotice",
    // Sets a text range's link.
    "text.link",
];

#[test]
fn every_command_in_a_server_family_is_refused_unless_reviewed_to_contact_none() {
    let forwarded: Vec<String> = engine_commands()
        .into_iter()
        .filter(|id| {
            let lower = id.to_ascii_lowercase();
            SERVER_PREFIXES.iter().any(|prefix| id.starts_with(prefix))
                || SERVER_WORDS.iter().any(|word| lower.contains(word))
        })
        .filter(|id| !refused(&route("engine.execute", &execute(id, json!({})))))
        .collect();
    assert_eq!(forwarded, CONTACTS_NO_SERVER);
}

/// The params of a wrapper's call that runs `inner` (`{command, params}`).
type Wrapping = fn(Value) -> Value;

/// Commands that run another command named in their params, each with a
/// call of it running the command `inner`.
const RUNS_THE_COMMAND_IT_NAMES: &[(&str, Wrapping)] = &[
    (
        "command.batch",
        |inner| json!({"commands": [{"command": "node.create", "params": {}}, inner]}),
    ),
    ("text.preview", |inner| inner),
];

/// Commands whose label or params speak of commands but name no engine
/// command they run, reviewed against the pinned engine.
const NAMES_NO_ENGINE_COMMAND: &[&str] = &[
    // `command` is one of the installed plugin's own commands. The engine
    // calls it makes go through figcraft's plugin policy and the
    // plugin's permissions, like every installed plugin run.
    "plugin.run",
    // Its params are widget layers; "the next command" is what ends its
    // hover preview.
    "widget.hover",
];

/// Whether a command's label or documented parameters (before the `→` of
/// its result) speak of commands.
fn names_a_command(spec: &Value) -> bool {
    let params = spec["params"].as_str().unwrap_or_default();
    let inputs = params.split('→').next().unwrap_or_default();
    format!("{} {inputs}", spec["label"].as_str().unwrap_or_default())
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.eq_ignore_ascii_case("command") || word.eq_ignore_ascii_case("commands"))
}

/// A command that runs a command it names would carry a refused command past
/// a policy that reads only the outer id, so every such command the engine
/// forwards is routed by the command it runs, or reviewed above.
#[test]
fn every_command_that_runs_a_command_it_names_is_routed_by_that_command() {
    let mut forwarded: Vec<String> = engine_specs()
        .iter()
        .filter(|spec| names_a_command(spec))
        .filter_map(|spec| spec["id"].as_str())
        .filter(|id| !refused(&route("engine.execute", &execute(id, json!({})))))
        .map(str::to_owned)
        .collect();
    forwarded.sort_unstable();
    let mut reviewed: Vec<&str> = RUNS_THE_COMMAND_IT_NAMES
        .iter()
        .map(|(id, _)| *id)
        .chain(NAMES_NO_ENGINE_COMMAND.iter().copied())
        .collect();
    reviewed.sort_unstable();
    assert_eq!(forwarded, reviewed);
    for (wrapper, call_running) in RUNS_THE_COMMAND_IT_NAMES {
        for (command, params, does) in REACHES_A_SERVER {
            let params: Value = serde_json::from_str(params).unwrap();
            let call = execute(
                wrapper,
                call_running(json!({"command": command, "params": params})),
            );
            let message = refusal("engine.execute", &call).message;
            assert!(
                message.ends_with(&format!(
                    "`{command}` {does}, which the Termul canvas does not allow"
                )),
                "{call}: {message}"
            );
        }
        let save = execute(wrapper, call_running(json!({"command": "file.save"})));
        refusal("engine.execute", &save);
    }
}

/// `edit.repeat` runs the editor's last command again: one Termul never saw
/// when the user ran it, such as a team library style from the Libraries
/// panel.
#[test]
fn repeating_the_editors_last_command_is_refused() {
    assert_eq!(
        refusal("engine.execute", &execute("edit.repeat", json!({}))).message,
        "`edit.repeat` runs the editor's last command again, which may be one the user ran and \
         which Termul cannot check, so the Termul canvas does not allow it. Run that command \
         itself instead"
    );
}

#[test]
fn an_android_vector_drawable_export_is_written_by_termul_with_its_options() {
    let (path, stripped) = export_to(
        "file.export",
        json!({"path": "res/drawable/ic_logo.xml", "vdCompat": "exact"}),
    );
    assert_eq!(path, "res/drawable/ic_logo.xml");
    assert_eq!(
        stripped["params"],
        json!({"format": "xml", "vdCompat": "exact"})
    );
}

#[test]
fn layers_exported_as_one_zip_come_back_inline_and_a_folder_is_refused() {
    assert_eq!(
        route(
            "engine.execute",
            &execute(
                "file.exportLayers",
                json!({"zip": true, "vdCompat": "exact"})
            )
        ),
        CanvasRoute::Forward
    );
    refusal(
        "engine.execute",
        &execute("file.exportLayers", json!({"zip": true, "dir": "out"})),
    );
}

/// A command the policy names but the engine renamed would pass unchecked.
#[test]
fn every_command_the_policy_names_is_one_the_pinned_engine_runs() {
    let engine = engine_commands();
    let unknown: Vec<&str> = COMMANDS
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !engine.contains(*name))
        .collect();
    assert_eq!(unknown, Vec::<&str>::new());
}

/// Every command id the pinned engine ran when the policy was last reviewed.
/// A command the engine adds reaches the editor unchecked until someone
/// decides it, so a new pin fails here until each new id is refused in
/// `COMMANDS` or judged safe for the editor, then listed.
#[test]
fn every_command_the_pinned_engine_runs_has_a_policy_decision() {
    let engine = engine_commands();
    let reviewed: std::collections::BTreeSet<String> = include_str!("reviewed_commands.txt")
        .lines()
        .map(str::to_owned)
        .collect();
    let undecided: Vec<&String> = engine.difference(&reviewed).collect();
    let removed: Vec<&String> = reviewed.difference(&engine).collect();
    assert!(
        undecided.is_empty() && removed.is_empty(),
        "decide each new command (refuse it in COMMANDS or leave it to the editor), then update \
         canvas_policy/reviewed_commands.txt. New: {undecided:?}. Gone: {removed:?}"
    );
}

/// An export path the policy gives a format to must be one the engine can
/// write, or the agent gets an engine error for a path Termul accepted.
#[test]
fn every_format_an_export_path_names_is_one_the_pinned_engine_exports() {
    use figcraft_mcp::Backend as _;
    for path in [
        "a.png", "a.jpg", "a.svg", "a.webp", "a.pdf", "a.xml", "a.fig",
    ] {
        let format = export_format(path).unwrap();
        let mut engine = figcraft_mcp::Headless::new();
        let rectangle = engine
            .call(
                "engine.execute",
                json!({"command": "node.create", "params": {
                    "type": "rectangle", "width": 10, "height": 10, "props": {"fill": "#336699"}
                }}),
            )
            .unwrap();
        let exported = engine.call(
            "engine.execute",
            json!({"command": "file.export", "params": {"ids": [rectangle["id"]], "format": format}}),
        );
        assert!(
            exported
                .as_ref()
                .is_ok_and(|reply| reply["data"].is_string()),
            "{format}: {exported:?}"
        );
    }
}

#[test]
fn a_batch_step_refused_on_its_own_refuses_the_batch_for_the_same_reason() {
    let batch = |step: Value| {
        execute(
            "command.batch",
            json!({"commands": [{"command": "node.create", "params": {}}, step]}),
        )
    };
    for (step, cause) in [
        (json!({"command": "file.markSaved"}), "without saving"),
        (json!({"command": "file.newBoard"}), "switches documents"),
        (
            json!({"command": "text.loadFont", "params": {"path": "a.ttf"}}),
            "reads or writes files",
        ),
        (
            json!({"command": "plugin.directory.install", "params": {"id": "x.y", "confirm": true}}),
            "plugin code",
        ),
    ] {
        let error = refusal("engine.execute", &batch(step.clone()));
        assert!(
            error.message.contains("step 1") && error.message.contains(cause),
            "{step}: {}",
            error.message
        );
    }
}

#[test]
fn a_batch_with_a_step_termul_must_handle_is_refused_whole() {
    let batch = |steps: Value| execute("command.batch", json!({"commands": steps}));
    let plain = json!([{"command": "node.create", "params": {"type": "frame"}}]);
    assert_eq!(route("engine.execute", &batch(plain)), CanvasRoute::Forward);
    for step in [
        json!({"command": "file.save"}),
        json!({"command": "file.export", "params": {"path": "a.png"}}),
        json!({"command": "file.open", "params": {"path": "a.figcraft"}}),
    ] {
        let steps = json!([{"command": "node.create", "params": {}}, step]);
        let CanvasRoute::Refuse(error) = route("engine.execute", &batch(steps)) else {
            panic!("{step} refuses the batch");
        };
        assert_eq!(error.code, CanvasErrorCode::UnsupportedInKiosk);
        assert!(error.message.contains("step 1"), "{}", error.message);
    }
}

struct Project(std::path::PathBuf);

impl Project {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("termul-canvas-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("project/assets")).unwrap();
        Self(root)
    }

    fn root(&self) -> std::path::PathBuf {
        self.0.join("project")
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_relative_path_inside_the_project_resolves_under_its_root() {
    let project = Project::new();
    let file = resolve_project_file(&project.root(), "./assets/new/hero.png").unwrap();
    let root = std::fs::canonicalize(project.root()).unwrap();
    assert_eq!(file.relative, "assets/new/hero.png");
    assert_eq!(
        file.absolute,
        root.join("assets").join("new").join("hero.png")
    );
}

#[test]
fn absolute_traversal_and_empty_paths_are_refused_naming_their_cause() {
    let project = Project::new();
    let absolute = project.root().join("assets").join("a.png");
    for (requested, cause) in [
        ("../outside.png", "`..`"),
        ("assets/../../outside.png", "`..`"),
        ("", "names no file"),
        (".", "names no file"),
        (absolute.to_str().unwrap(), "absolute"),
        ("/etc/passwd", "absolute"),
    ] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert_eq!(
            error.code,
            CanvasErrorCode::UnsupportedInKiosk,
            "{requested:?}"
        );
        assert!(
            error.message.contains(cause),
            "{requested:?}: {}",
            error.message
        );
    }
}

#[test]
fn alternate_stream_and_device_names_are_refused_on_every_platform() {
    let project = Project::new();
    for requested in [
        "a.png:hidden",
        "assets/a.png:x:$DATA",
        "assets:x/a.png",
        "CON",
        "con.png",
        "assets/NUL",
        "assets/nul.tar.gz",
        "Aux.svg",
        "prn",
        "COM1.png",
        "lpt9",
        "COM\u{b9}.png",
        "CON .png",
        "CONIN$",
        "conout$.pdf",
    ] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert_eq!(
            error.code,
            CanvasErrorCode::UnsupportedInKiosk,
            "{requested:?}"
        );
        assert!(
            error.message.contains("stream or device"),
            "{requested:?}: {}",
            error.message
        );
    }
}

#[test]
fn names_that_only_resemble_device_names_resolve() {
    let project = Project::new();
    for requested in [
        "console.png",
        "assets/nul-free.png",
        "COM10.png",
        "lpt.png",
        "aux_icons/a.png",
        "my.con.png",
    ] {
        assert!(
            resolve_project_file(&project.root(), requested).is_ok(),
            "{requested}"
        );
    }
}

#[cfg(windows)]
#[test]
fn drive_relative_and_rooted_windows_paths_are_refused() {
    let project = Project::new();
    for requested in ["C:a.png", r"\a.png", r"\\server\share\a.png"] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert!(
            error.message.contains("absolute"),
            "{requested}: {}",
            error.message
        );
    }
}

/// A real NTFS junction on Windows, which is how a worktree links a shared
/// folder; a symlink elsewhere.
fn junction(target: &std::path::Path, link: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J failed");
    }
}

#[test]
fn a_link_out_of_the_project_is_refused_naming_the_link_and_its_target() {
    let project = Project::new();
    let outside = project.0.join("main-checkout").join("out");
    std::fs::create_dir_all(&outside).unwrap();
    junction(&outside, &project.root().join("out"));
    junction(&outside, &project.root().join("assets").join("shared"));
    let target = std::fs::canonicalize(&outside).unwrap();
    let target =
        crate::path_validation::strip_verbatim_prefix(&target.to_string_lossy()).into_owned();
    for (requested, link) in [
        ("out/landing/x.png", "`out`"),
        ("out/x.png", "`out`"),
        ("out", "`out`"),
        ("assets/shared/x.png", "`assets/shared`"),
    ] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert_eq!(
            error.code,
            CanvasErrorCode::UnsupportedInKiosk,
            "{requested}"
        );
        assert!(
            error.message.contains(&format!(
                "{link} is a link to `{target}`, which is outside the project"
            )),
            "{requested}: {}",
            error.message
        );
    }
}

#[test]
fn a_link_out_of_the_project_is_refused() {
    let project = Project::new();
    let outside = project.0.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let link = project.root().join("escape");
    if let Err(error) = link_dir(&outside, &link) {
        eprintln!("skipped: this machine cannot create a symlink ({error})");
        return;
    }
    for requested in ["escape/a.png", "escape/deeper/a.png", "escape"] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert_eq!(
            error.code,
            CanvasErrorCode::UnsupportedInKiosk,
            "{requested}"
        );
    }
    std::fs::create_dir_all(project.root().join("inner")).unwrap();
    let inside_link = project.root().join("alias");
    link_dir(&project.root().join("inner"), &inside_link).unwrap();
    assert!(resolve_project_file(&project.root(), "alias/a.png").is_ok());
}

/// A directory link: a symlink, or on Windows without the symlink privilege a
/// junction, which needs none.
fn link_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    }
}

#[cfg(windows)]
#[test]
fn an_export_write_holds_its_folders_so_none_can_be_swapped_for_a_link() {
    let project = Project::new();
    let root = std::fs::canonicalize(project.root()).unwrap();
    let written = write_project_file(&project.root(), "assets/icons/a.png", b"png").unwrap();
    assert_eq!(std::fs::read(&written.absolute).unwrap(), b"png");

    let held = hold_real_folders(&root, &root.join("assets").join("icons")).unwrap();
    assert!(
        std::fs::rename(root.join("assets"), root.join("moved")).is_err(),
        "a held folder cannot be moved aside for a link"
    );
    drop(held);
    std::fs::rename(root.join("assets"), root.join("moved")).unwrap();

    let outside = project.0.join("outside");
    std::fs::create_dir_all(outside.join("icons")).unwrap();
    if let Err(error) = link_dir(&outside, &root.join("assets")) {
        eprintln!("skipped: this machine cannot create a directory link ({error})");
        return;
    }
    assert!(
        hold_real_folders(&root, &root.join("assets").join("icons")).is_err(),
        "a folder swapped for a link since the check is refused"
    );
}

#[cfg(unix)]
#[test]
fn an_export_write_refuses_a_folder_that_is_a_link() {
    let project = Project::new();
    let root = std::fs::canonicalize(project.root()).unwrap();
    let written = write_project_file(&project.root(), "assets/icons/a.png", b"png").unwrap();
    assert_eq!(std::fs::read(&written.absolute).unwrap(), b"png");
    write_project_file(&project.root(), "assets/icons/a.png", b"png2").unwrap();
    assert_eq!(std::fs::read(&written.absolute).unwrap(), b"png2");

    std::fs::rename(root.join("assets"), root.join("moved")).unwrap();
    let outside = project.0.join("outside");
    std::fs::create_dir_all(outside.join("icons")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("assets")).unwrap();
    assert!(
        write_in_real_folder(
            &root,
            &root.join("assets").join("icons"),
            "a.png".as_ref(),
            b"escaped"
        )
        .is_err(),
        "a folder swapped for a link since the check is refused"
    );
    assert!(!outside.join("icons").join("a.png").exists());
}

#[cfg(unix)]
#[test]
fn an_export_write_lands_in_the_folder_it_opened_even_if_it_moves() {
    let project = Project::new();
    let root = std::fs::canonicalize(project.root()).unwrap();
    std::fs::create_dir_all(root.join("assets").join("icons")).unwrap();
    let folder = open_real_folder(&root, &root.join("assets").join("icons")).unwrap();

    std::fs::rename(root.join("assets"), root.join("moved")).unwrap();
    let outside = project.0.join("outside");
    std::fs::create_dir_all(outside.join("icons")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("assets")).unwrap();

    use std::os::fd::AsFd;
    crate::acp::atomic_file::replace_at(folder.as_fd(), "a.png".as_ref(), b"png").unwrap();
    assert_eq!(
        std::fs::read(root.join("moved").join("icons").join("a.png")).unwrap(),
        b"png"
    );
    assert!(!outside.join("icons").join("a.png").exists());
    let leftovers: Vec<_> = std::fs::read_dir(root.join("moved").join("icons"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, ["a.png"]);
}

/// `ui.key` params pressing `spec`, a figcraft key binding (`Shift+Cmd+K`).
fn pressing(spec: &str) -> Value {
    let mut params = serde_json::Map::new();
    for part in spec.split('+') {
        match part {
            "Shift" | "Cmd" | "Ctrl" | "Alt" => {
                params.insert(part.to_ascii_lowercase(), json!(true));
            }
            key => {
                params.insert("key".to_string(), json!(key));
            }
        }
    }
    Value::Object(params)
}

/// `ui.key` runs the command its key is bound to, so a shortcut for a
/// command the policy refuses or handles itself would run it past the
/// policy: every such binding, on either platform, is refused naming it.
#[test]
fn every_shortcut_for_a_command_termul_refuses_or_handles_is_refused() {
    use figcraft_engine::keymap::{bindings, Platform};
    let mut pressed = Vec::new();
    for (command, _) in COMMANDS {
        if route("engine.execute", &execute(command, json!({}))) == CanvasRoute::Forward {
            continue;
        }
        for platform in [Platform::Mac, Platform::Other] {
            for spec in bindings(command, platform) {
                let message = refusal("ui.key", &pressing(spec)).message;
                assert!(
                    message.contains(&format!("runs the shortcut `{command}`: ")),
                    "{spec}: {message}"
                );
                pressed.push(*command);
            }
        }
    }
    pressed.sort_unstable();
    pressed.dedup();
    assert_eq!(
        pressed,
        [
            "collab.cursorChat",
            "doc.nextTab",
            "doc.previousTab",
            "file.close",
            "file.new",
            "file.open",
            "file.save",
            "file.saveAs",
            "text.openLink",
        ]
    );
    for spec in ["Cmd+Z", "R", "Shift+Cmd+E", "Shift+Cmd+K", "Escape"] {
        assert_eq!(
            route("ui.key", &pressing(spec)),
            CanvasRoute::Forward,
            "{spec}"
        );
    }
}

/// Pressing New file through the `key` tool would put a second document in
/// front of the project's, which Termul's save would then write over it.
#[test]
fn a_shortcut_cannot_open_a_second_document() {
    use figcraft_mcp::Backend as _;
    let mut editor = figcraft_mcp::Headless::new();
    let documents = |editor: &mut figcraft_mcp::Headless| {
        editor
            .call("engine.execute", execute("doc.list", json!({})))
            .unwrap()
    };
    let before = documents(&mut editor);
    let press = json!({"key": "N", "cmd": true});
    let refused = match route("ui.key", &press) {
        CanvasRoute::Forward => {
            let _ = editor.call("ui.key", press);
            None
        }
        CanvasRoute::Refuse(error) => Some(error.message),
        other => panic!("{other:?}"),
    };
    assert_eq!(documents(&mut editor), before);
    assert_eq!(
        refused.as_deref(),
        Some(
            "`ui.key` cmd+N runs the shortcut `file.new`: `file.new` opens, closes or switches \
             documents, which the Termul canvas does not allow: it shows only the project's \
             document, with no tabs to switch back, and Termul's save would write the document \
             in front over the project's canvas file"
        )
    );
}

/// The key bindings the policy reads come from the same engine the
/// `figcraft-mcp` pin builds, never a second copy at another tag.
#[test]
fn the_policy_reads_key_bindings_from_the_pinned_engine() {
    let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).unwrap();
    let engines: Vec<&str> = lock
        .split("\n[[package]]\n")
        .filter(|package| package.starts_with("name = \"figcraft-engine\"\n"))
        .collect();
    assert_eq!(engines.len(), 1, "{engines:#?}");
}
