use serde_json::json;

use super::*;

fn execute(command: &str, params: Value) -> Value {
    json!({ "command": command, "params": params })
}

fn refused(route: &CanvasRoute) -> bool {
    matches!(route, CanvasRoute::Refuse(error) if error.code == CanvasErrorCode::UnsupportedInKiosk)
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

#[test]
fn save_is_the_host_save_whatever_path_it_names() {
    for params in [json!({}), json!({"path": "C:/elsewhere/doc.figcraft"})] {
        assert_eq!(
            route("engine.execute", &execute("file.save", params)),
            CanvasRoute::HostSave
        );
    }
}

#[test]
fn an_export_with_a_path_runs_without_it_and_keeps_its_options() {
    for command in ["file.export", "file.exportSvg", "file.exportFramesPdf"] {
        let params =
            json!({"path": "out/a.pdf", "ids": [18_446_744_073_709_551_615u64], "cmyk": true});
        let CanvasRoute::ExportTo {
            path,
            execute: stripped,
        } = route("engine.execute", &execute(command, params))
        else {
            panic!("{command} with a path is written by Termul");
        };
        assert_eq!(path, "out/a.pdf");
        assert_eq!(
            stripped,
            execute(
                command,
                json!({"ids": [18_446_744_073_709_551_615u64], "cmyk": true})
            )
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
fn absolute_traversal_and_empty_paths_are_refused() {
    let project = Project::new();
    let absolute = project.root().join("assets").join("a.png");
    for requested in [
        "../outside.png",
        "assets/../../outside.png",
        "",
        ".",
        absolute.to_str().unwrap(),
        "/etc/passwd",
    ] {
        let error = resolve_project_file(&project.root(), requested).unwrap_err();
        assert_eq!(
            error.code,
            CanvasErrorCode::UnsupportedInKiosk,
            "{requested:?}"
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
        assert!(
            resolve_project_file(&project.root(), requested).is_err(),
            "{requested}"
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
