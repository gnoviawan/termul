//! Tests for the AppImage child-environment scrub (gh-1435).
//!
//! The command-builder behavior (`env_remove` scheduling) is not directly
//! observable on a `Command`, so these tests prove the effect end-to-end: a
//! sanitized command spawns a child that prints its own environment, and the
//! AppImage variables are absent while unrelated variables survive.

use std::collections::HashMap;
use std::process::{Command, Stdio};

use super::{remove_appimage_env_keys_from_map, sanitize_appimage_env};

/// Path to a binary that can print `KEY=VALUE` lines for its environment.
/// `/usr/bin/env` fits on every Unix; the test is skipped when absent.
#[cfg(target_os = "linux")]
fn env_printer() -> Option<&'static str> {
    if std::path::Path::new("/usr/bin/env").exists() {
        Some("/usr/bin/env")
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn sanitized_env_snapshot() -> Option<String> {
    let printer = env_printer()?;
    let mut command = Command::new(printer);
    sanitize_appimage_env(&mut command);
    let output = command
        .stdin(Stdio::null())
        .output()
        .expect("spawn /usr/bin/env");
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "linux")]
#[test]
fn sanitized_child_env_drops_appimage_keys() {
    // Simulate the AppImage runtime exports; the real AppImage sets these
    // before main() runs, tests cannot rely on them being present.
    let keys = [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "APPDIR",
        "APPIMAGE",
        "OW8UVFJ",
    ];
    let mut command = Command::new(env_printer().expect("/usr/bin/env"));
    for key in keys {
        command.env(key, "/tmp/.mount_TermulXXXXXX/usr/lib");
    }
    sanitize_appimage_env(&mut command);
    let output = command
        .stdin(Stdio::null())
        .output()
        .expect("spawn /usr/bin/env");
    let stdout = String::from_utf8_lossy(&output.stdout);
    for key in keys {
        assert!(
            !stdout.contains(&format!("{key}=")),
            "sanitized child env still contains {key}"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn sanitized_child_env_keeps_unrelated_variables() {
    let mut command = Command::new(env_printer().expect("/usr/bin/env"));
    command.env("TERMUL_TEST_MARKER", "survives");
    sanitize_appimage_env(&mut command);
    let output = command
        .stdin(Stdio::null())
        .output()
        .expect("spawn /usr/bin/env");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("TERMUL_TEST_MARKER=survives"),
        "unrelated variable was dropped: {stdout}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn sanitize_without_appimage_env_is_noop_for_path() {
    // With no AppImage variables set (a dev run), PATH must survive the scrub
    // so resolution of host binaries is unchanged.
    let snapshot = sanitized_env_snapshot().expect("spawn /usr/bin/env");
    let has_path = snapshot.lines().any(|line| {
        line.split_once('=')
            .is_some_and(|(key, _)| key == "PATH")
    });
    assert!(has_path, "PATH missing from sanitized child env");
}

#[cfg(not(target_os = "linux"))]
#[test]
fn sanitize_is_noop_off_linux() {
    let mut command = Command::new("does-not-matter");
    // Compiles and returns the command without touching the environment.
    sanitize_appimage_env(&mut command);
}

#[test]
fn map_scrub_removes_appimage_keys_and_keeps_the_rest() {
    let mut env = HashMap::from([
        (
            "LD_LIBRARY_PATH".to_string(),
            "/tmp/.mount_TermulXXXXXX/usr/lib".to_string(),
        ),
        ("APPDIR".to_string(), "/tmp/.mount_TermulXXXXXX".to_string()),
        ("PATH".to_string(), "/usr/bin:/bin".to_string()),
        ("HOME".to_string(), "/home/user".to_string()),
    ]);
    remove_appimage_env_keys_from_map(&mut env);
    assert!(!env.contains_key("LD_LIBRARY_PATH"));
    assert!(!env.contains_key("APPDIR"));
    assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
    assert_eq!(env.get("HOME").map(String::as_str), Some("/home/user"));
}

#[test]
fn map_scrub_on_clean_map_changes_nothing() {
    let mut env = HashMap::from([(
        "PATH".to_string(),
        "/usr/bin:/bin".to_string(),
    )]);
    remove_appimage_env_keys_from_map(&mut env);
    assert_eq!(env.len(), 1);
}
