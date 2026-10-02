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
