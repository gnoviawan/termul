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
