use super::*;

#[cfg(target_os = "windows")]
fn with_test_comspec<T>(f: impl FnOnce() -> T) -> T {
    use std::ffi::OsString;

    struct ComspecGuard(Option<OsString>);

    impl Drop for ComspecGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.0 {
                std::env::set_var("COMSPEC", value);
            } else {
                std::env::remove_var("COMSPEC");
            }
        }
    }

    let _guard = ComspecGuard(std::env::var_os("COMSPEC"));
    std::env::set_var("COMSPEC", r"C:\Windows\System32\cmd.exe");
    f()
}

#[test]
fn test_fallback_shell() {
    #[cfg(target_os = "windows")]
    let shell = with_test_comspec(|| get_default_shell_info().unwrap());
    #[cfg(not(target_os = "windows"))]
    let shell = get_default_shell_info().unwrap();

    #[cfg(target_os = "windows")]
    assert_eq!(shell.name, "cmd");
    #[cfg(not(target_os = "windows"))]
    assert!(shell.name == "sh" || shell.name == "bash" || shell.name == "zsh");
}

#[test]
fn test_get_default_shell_returns_some() {
    let shell = get_default_shell_info();
    assert!(shell.is_some());
}

#[test]
fn test_get_available_shells_not_empty() {
    let shells = get_available_shells();
    assert!(!shells.is_empty());
}

#[test]
fn test_get_home_directory_command() {
    let result = get_home_directory();
    assert!(result.is_ok());
    assert!(!result.unwrap().is_empty());
}

#[cfg(target_os = "windows")]
#[test]
fn test_is_builtin_windows_shell() {
    assert!(is_builtin_windows_shell("cmd"));
    assert!(is_builtin_windows_shell("CMD.EXE"));
    assert!(is_builtin_windows_shell("powershell"));
    assert!(is_builtin_windows_shell("pwsh"));
    assert!(is_builtin_windows_shell("wsl"));
    assert!(!is_builtin_windows_shell("bash.exe"));
    assert!(!is_builtin_windows_shell("git-bash"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_resolve_executable_from_path_nonexistent() {
    let result = resolve_executable_from_path("definitely-not-a-real-shell-xyz");
    assert!(result.is_none());
}

// ========== Git Bash candidate sync tests ==========

#[cfg(target_os = "windows")]
#[test]
fn test_git_bash_primary_candidates_defined() {
    // Verify primary Git Bash candidates are defined (compile-time guard)
    const { assert!(!git_bash_paths::PRIMARY_PATHS.is_empty()) };

    // Verify specific well-known paths exist
    assert!(git_bash_paths::PRIMARY_PATHS
        .iter()
        .any(|p| p.contains("Program Files") && p.contains("Git\\bin")));
    assert!(git_bash_paths::PRIMARY_PATHS
        .iter()
        .any(|p| p.contains("Git\\usr\\bin")));
}

#[cfg(target_os = "windows")]
#[test]
fn test_git_bash_fallback_candidates_defined() {
    // Verify fallback Git Bash candidates are defined (compile-time guard)
    const { assert!(!git_bash_paths::FALLBACK_PATHS.is_empty()) };

    // All fallback paths should contain bash.exe
    for path in git_bash_paths::FALLBACK_PATHS {
        assert!(
            path.contains("bash.exe"),
            "Fallback path should contain bash.exe: {}",
            path
        );
    }
}

#[test]
fn test_git_bash_shell_display_name() {
    let display_name = shell_display_name("git-bash");
    assert_eq!(display_name, "Git Bash");
}
#[test]
fn test_main_webview_allows_app_internal_schemes() {
    assert!(main_webview_allows_navigation(
        &"tauri://localhost".parse().unwrap()
    ));
    assert!(main_webview_allows_navigation(
        &"ipc://localhost".parse().unwrap()
    ));
    assert!(main_webview_allows_navigation(
        &"blob:https://termul.app/".parse().unwrap()
    ));
}

#[test]
fn test_main_webview_allows_windows_production_origin_in_release() {
    // Tauri 2 serves the SPA at http://tauri.localhost (no explicit port)
    // on Windows in packaged builds (no useHttpsScheme override in
    // tauri.conf.json). The policy must allow this exact origin or the
    // main webview stays blank.
    let windows_app_origin = "http://tauri.localhost/tauri-index.html"
        .parse::<tauri::Url>()
        .unwrap();
    if cfg!(all(not(dev), target_os = "windows")) {
        assert!(main_webview_allows_navigation(&windows_app_origin));
    } else {
        // In dev (Vite on localhost) or on non-Windows release (uses the
        // `tauri` scheme, not tauri.localhost), the Windows origin must
        // be rejected.
        assert!(!main_webview_allows_navigation(&windows_app_origin));
    }

    // The exact-origin restriction: HTTPS, explicit ports, and the same
    // host on a non-Windows target are all rejected. These hold
    // regardless of dev/release because the allow-list gates on
    // cfg!(all(not(dev), target_os = "windows")).
    assert!(!main_webview_allows_navigation(
        &"https://tauri.localhost/tauri-index.html".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"http://tauri.localhost:8080/tauri-index.html"
            .parse()
            .unwrap()
    ));
}

#[test]
fn test_main_webview_allows_dev_localhost_only_when_dev() {
    // The dev allowance is a compile-time gate. In a dev build, localhost
    // navigations are allowed (Vite dev server); in a release build they
    // are rejected because the main webview is the SPA document only
    // (Windows release uses tauri.localhost, tested above).
    let localhost = "http://localhost:5180/tauri-index.html"
        .parse::<tauri::Url>()
        .unwrap();
    let external = "https://example.com".parse::<tauri::Url>().unwrap();

    if cfg!(dev) {
        assert!(main_webview_allows_navigation(&localhost));
        // External URLs are still blocked in dev so a chat link cannot
        // tear down the SPA — only the local dev server is trusted.
        assert!(!main_webview_allows_navigation(&external));
    } else {
        assert!(!main_webview_allows_navigation(&localhost));
        assert!(!main_webview_allows_navigation(&external));
    }
}

#[test]
fn test_main_webview_rejects_active_data_documents() {
    // A top-level navigation to data:text/html can replace the SPA with an
    // active document (arbitrary inline script). Reject it. Note: this
    // does not affect <img src="data:"> resource loads, only navigation.
    assert!(!main_webview_allows_navigation(
        &"data:text/html,<script>alert(1)</script>".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"data:text/plain,hello".parse().unwrap()
    ));
}

#[test]
fn test_main_webview_rejects_external_urls() {
    // The core invariant of issue #406: a chat-link click to an external
    // site must never replace the app. This holds in both dev and release.
    assert!(!main_webview_allows_navigation(
        &"https://example.com".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"https://tauri.app/guide".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"http://example.com".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"ftp://example.com".parse().unwrap()
    ));
    assert!(!main_webview_allows_navigation(
        &"market://details?id=app".parse().unwrap()
    ));
}

const CANVAS_PORT: u16 = 64451;

fn canvas_frame(url: &str, canvas_port: Option<u16>) -> Option<CanvasFrameNavigation> {
    canvas_frame_navigation(&url.parse().unwrap(), canvas_port)
}

#[test]
fn canvas_bundle_on_the_live_listener_is_a_canvas_frame_navigation() {
    // Issue #1490: the iframe URL CanvasShell sets. Before the fix the guard
    // had no canvas exception and rejected it in release builds.
    let iframe = format!(
        "http://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/?embed=kiosk&ho=tauri%3A%2F%2Flocalhost&ms=2"
    );
    assert_eq!(
        canvas_frame(&iframe, Some(CANVAS_PORT)),
        Some(CanvasFrameNavigation::Bundle { port: CANVAS_PORT })
    );
    // The bare token path the listener redirects to its trailing-slash form.
    assert_eq!(
        canvas_frame(
            &format!("http://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc"),
            Some(CANVAS_PORT)
        ),
        Some(CanvasFrameNavigation::Bundle { port: CANVAS_PORT })
    );
    assert_eq!(
        canvas_frame("about:blank", None),
        Some(CanvasFrameNavigation::InitialDocument)
    );
}

#[test]
fn canvas_frame_exception_rejects_everything_but_the_bundle_listener() {
    let port = Some(CANVAS_PORT);
    let rejected = [
        // Another loopback port (an agent's dev server, a stale listener).
        "http://127.0.0.1:5180/canvas/cv0123/tok-abc/".to_string(),
        // The listener port, but outside /canvas/.
        format!("http://127.0.0.1:{CANVAS_PORT}/"),
        format!("http://127.0.0.1:{CANVAS_PORT}/canvasx/cv0123/tok-abc/"),
        format!("http://127.0.0.1:{CANVAS_PORT}/api/canvas/cv0123/"),
        format!("http://127.0.0.1:{CANVAS_PORT}/canvas"),
        // A path that only normalizes back out of /canvas/.
        format!("http://127.0.0.1:{CANVAS_PORT}/canvas/../evil"),
        // Other hosts and schemes on the listener port.
        format!("http://localhost:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        format!("http://[::1]:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        format!("http://example.com:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        format!("https://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        format!("http://user:pass@127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        format!("ws://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
        // Other about: documents.
        "about:srcdoc".to_string(),
        "about:config".to_string(),
        "data:text/html,<script>alert(1)</script>".to_string(),
        "https://example.com/canvas/".to_string(),
    ];
    for url in &rejected {
        assert_eq!(canvas_frame(url, port), None, "{url} must not be admitted");
    }
    // While the listener is down or rebinding no loopback URL is admitted.
    assert_eq!(
        canvas_frame(
            &format!("http://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/"),
            None
        ),
        None
    );
}

#[test]
fn main_webview_navigation_admits_the_canvas_frame_and_keeps_the_406_policy() {
    let port = Some(CANVAS_PORT);
    let bundle = format!("http://127.0.0.1:{CANVAS_PORT}/canvas/cv0123/tok-abc/?embed=kiosk")
        .parse::<tauri::Url>()
        .unwrap();
    let other_port = "http://127.0.0.1:5180/canvas/cv0123/tok-abc/"
        .parse::<tauri::Url>()
        .unwrap();
    if cfg!(dev) {
        // Dev already trusts every loopback page (the Vite dev server).
        assert_eq!(
            main_webview_navigation(&bundle, port),
            MainNavigation::Allowed
        );
        assert_eq!(
            main_webview_navigation(&other_port, port),
            MainNavigation::Allowed
        );
    } else {
        assert_eq!(
            main_webview_navigation(&bundle, port),
            MainNavigation::CanvasFrame(CanvasFrameNavigation::Bundle { port: CANVAS_PORT })
        );
        assert_eq!(
            main_webview_navigation(&other_port, port),
            MainNavigation::Blocked
        );
        assert_eq!(
            main_webview_navigation(&bundle, None),
            MainNavigation::Blocked
        );
    }
    assert_eq!(
        main_webview_navigation(&"about:blank".parse().unwrap(), port),
        MainNavigation::CanvasFrame(CanvasFrameNavigation::InitialDocument)
    );
    assert_eq!(
        main_webview_navigation(&"tauri://localhost".parse().unwrap(), port),
        MainNavigation::Allowed
    );
    // The #406 invariant holds with the canvas listener up.
    for external in [
        "https://example.com",
        "http://example.com/canvas/cv0123/tok-abc/",
        "data:text/html,<script>alert(1)</script>",
    ] {
        assert_eq!(
            main_webview_navigation(&external.parse().unwrap(), port),
            MainNavigation::Blocked,
            "{external}"
        );
    }
}

fn csp_directive(csp: &str, name: &str) -> String {
    csp.split(';')
        .map(str::trim)
        .find(|directive| directive.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("{name} directive present in {csp}"))
        .to_string()
}

#[test]
fn csp_admits_https_and_blob_media_but_not_https_scripts_or_fetches() {
    let conf_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    let conf = std::fs::read_to_string(conf_path).expect("tauri.conf.json readable");
    let conf: serde_json::Value = serde_json::from_str(&conf).expect("tauri.conf.json is JSON");
    let csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp is a string");

    for name in ["img-src", "media-src"] {
        let sources: Vec<String> = csp_directive(csp, name)
            .split_whitespace()
            .map(str::to_string)
            .collect();
        assert!(
            sources.contains(&"https:".to_string()),
            "{name} allows https: {csp}"
        );
        assert!(
            sources.contains(&"blob:".to_string()),
            "{name} allows blob: {csp}"
        );
    }
    for name in ["script-src", "connect-src"] {
        let directive = csp_directive(csp, name);
        assert!(
            !directive
                .split_whitespace()
                .any(|source| source == "https:"),
            "{name} must not admit every https origin: {directive}"
        );
    }
}

/// Config-drift fence for the canvas embed: the desktop main webview iframes
/// the figcraft bundle listener at `http://127.0.0.1:<dynamic port>`, so the
/// CSP MUST keep a loopback-scoped `frame-src` (iframe load) and
/// `connect-src` (the bundle's own fetches) — while staying scoped to
/// loopback only (never a bare `http:` or `*` source, which would open
/// arbitrary origins).
#[test]
fn canvas_csp_keeps_loopback_scoped_frame_and_connect_sources() {
    let conf_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    let conf = std::fs::read_to_string(conf_path).expect("tauri.conf.json readable");
    let conf: serde_json::Value = serde_json::from_str(&conf).expect("tauri.conf.json is JSON");
    let csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp is a string");

    // Loopback-scoped frame-src for the bundle iframe.
    assert!(
        csp.contains("frame-src http://127.0.0.1:*"),
        "CSP must allow loopback frame-src for the canvas bundle iframe: {csp}"
    );
    // Loopback-scoped connect-src for the bundle's fetches.
    assert!(
        csp.contains("connect-src") && csp.contains("http://127.0.0.1:*"),
        "CSP must allow loopback connect-src for canvas bundle traffic: {csp}"
    );
    // Scoped to loopback only — no bare wildcard/protocol sources that
    // would admit arbitrary origins.
    let frame_src_directive = csp
        .split(';')
        .find(|directive| directive.trim_start().starts_with("frame-src"))
        .expect("frame-src directive present");
    assert!(
        !frame_src_directive.contains("* http:") && !frame_src_directive.contains("http://*"),
        "frame-src must stay loopback-scoped, not wildcard: {frame_src_directive}"
    );
}
