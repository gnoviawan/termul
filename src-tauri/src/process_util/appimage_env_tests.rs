//! Unit tests for the AppImage child-env hygiene planner. All pure/in-memory:
//! the planner is driven by a `HashMap`-backed `get` so the real process env is
//! never mutated. These run on Linux (and every unix) — they are deliberately
//! NOT gated by `cfg(windows)` like the console tests.

use std::collections::HashMap;
use std::ffi::OsString;

use super::appimage_env::{plan_appimage_env_cleanup, EnvEdit};

/// Build a `get` closure over a map of string pairs.
fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let map: HashMap<String, OsString> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), OsString::from(v)))
        .collect();
    move |name: &str| map.get(name).cloned()
}

/// A minimal AppImage gate (both vars present and non-empty) plus `extra`.
fn gated(extra: &[(&str, &str)]) -> Vec<(String, EnvEdit)> {
    let mut pairs = vec![
        ("APPDIR", "/tmp/.mount_abc"),
        ("APPIMAGE", "/home/u/Termul.AppImage"),
    ];
    pairs.extend_from_slice(extra);
    plan_appimage_env_cleanup(env(&pairs))
}

fn find<'a>(edits: &'a [(String, EnvEdit)], name: &str) -> Option<&'a EnvEdit> {
    edits.iter().find(|(n, _)| n == name).map(|(_, e)| e)
}

fn set(value: &str) -> EnvEdit {
    EnvEdit::Set(OsString::from(value))
}

#[test]
fn gate_closed_when_appdir_missing() {
    let edits = plan_appimage_env_cleanup(env(&[
        ("APPIMAGE", "/home/u/Termul.AppImage"),
        ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib"),
    ]));
    assert!(edits.is_empty());
}

#[test]
fn gate_closed_when_appimage_missing() {
    let edits = plan_appimage_env_cleanup(env(&[
        ("APPDIR", "/tmp/.mount_abc"),
        ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib"),
    ]));
    assert!(edits.is_empty());
}

#[test]
fn gate_closed_when_either_var_empty() {
    // Empty APPDIR or empty APPIMAGE keeps the gate closed even with pollution.
    let polluted = &[("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib")];

    let empty_appdir = plan_appimage_env_cleanup(env(&[
        ("APPDIR", ""),
        ("APPIMAGE", "/home/u/Termul.AppImage"),
        polluted[0],
    ]));
    assert!(empty_appdir.is_empty());

    let empty_appimage = plan_appimage_env_cleanup(env(&[
        ("APPDIR", "/tmp/.mount_abc"),
        ("APPIMAGE", ""),
        polluted[0],
    ]));
    assert!(empty_appimage.is_empty());
}

#[test]
fn ld_library_path_filtered_keeps_host_entries_in_order() {
    let edits = gated(&[(
        "LD_LIBRARY_PATH",
        "/tmp/.mount_abc/usr/lib:/opt/host/lib:/tmp/.mount_abc/usr/lib/x:/usr/lib",
    )]);
    assert_eq!(
        find(&edits, "LD_LIBRARY_PATH"),
        Some(&set("/opt/host/lib:/usr/lib"))
    );
}

#[test]
fn ld_library_path_fully_polluted_is_removed() {
    let edits = gated(&[(
        "LD_LIBRARY_PATH",
        "/tmp/.mount_abc/usr/lib:/tmp/.mount_abc/usr/lib/x",
    )]);
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), Some(&EnvEdit::Remove));
}

#[test]
fn ld_library_path_unchanged_emits_no_edit() {
    let edits = gated(&[("LD_LIBRARY_PATH", "/opt/host/lib:/usr/lib")]);
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), None);
}

#[test]
fn boundary_rule_does_not_match_sibling_prefix() {
    // `/tmp/.mount_abcd` is a sibling of `$APPDIR` (`/tmp/.mount_abc`), not
    // under it, so its entry must survive.
    let edits = gated(&[(
        "LD_LIBRARY_PATH",
        "/tmp/.mount_abcd/usr/lib:/tmp/.mount_abc/usr/lib",
    )]);
    assert_eq!(
        find(&edits, "LD_LIBRARY_PATH"),
        Some(&set("/tmp/.mount_abcd/usr/lib"))
    );
}

#[test]
fn appdir_itself_is_treated_as_under_appdir() {
    let edits = gated(&[("LD_LIBRARY_PATH", "/tmp/.mount_abc:/usr/lib")]);
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), Some(&set("/usr/lib")));
}

#[test]
fn ld_library_path_orig_restores_value() {
    let edits = gated(&[
        ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib"),
        ("LD_LIBRARY_PATH_ORIG", "/opt/host/lib"),
    ]);
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), Some(&set("/opt/host/lib")));
}

#[test]
fn ld_library_path_empty_orig_removes() {
    let edits = gated(&[
        ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib"),
        ("LD_LIBRARY_PATH_ORIG", ""),
    ]);
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), Some(&EnvEdit::Remove));
}

#[test]
fn ld_preload_without_orig_is_removed() {
    let edits = gated(&[("LD_PRELOAD", "/tmp/.mount_abc/usr/lib/libwayland.so")]);
    assert_eq!(find(&edits, "LD_PRELOAD"), Some(&EnvEdit::Remove));
}

#[test]
fn ld_preload_host_value_without_orig_is_still_removed() {
    // Even a host-looking LD_PRELOAD is dropped for children: the #1497 wrapper
    // sets it only for the app's own WebKit, never for rg/node/git/xdg-open.
    let edits = gated(&[("LD_PRELOAD", "/usr/lib/host/libwayland-client.so.0")]);
    assert_eq!(find(&edits, "LD_PRELOAD"), Some(&EnvEdit::Remove));
}

#[test]
fn ld_preload_orig_restores_value() {
    let edits = gated(&[
        ("LD_PRELOAD", "/tmp/.mount_abc/usr/lib/libwayland.so"),
        ("LD_PRELOAD_ORIG", "/usr/lib/host/libwayland-client.so.0"),
    ]);
    assert_eq!(
        find(&edits, "LD_PRELOAD"),
        Some(&set("/usr/lib/host/libwayland-client.so.0"))
    );
}

#[test]
fn ld_preload_empty_orig_removes() {
    let edits = gated(&[
        ("LD_PRELOAD", "/tmp/.mount_abc/usr/lib/libwayland.so"),
        ("LD_PRELOAD_ORIG", ""),
    ]);
    assert_eq!(find(&edits, "LD_PRELOAD"), Some(&EnvEdit::Remove));
}

#[test]
fn ld_preload_absent_emits_no_edit() {
    let edits = gated(&[]);
    assert_eq!(find(&edits, "LD_PRELOAD"), None);
}

#[test]
fn path_drops_appdir_entries_but_is_never_emptied() {
    let edits = gated(&[("PATH", "/tmp/.mount_abc/usr/bin:/usr/bin:/bin")]);
    assert_eq!(find(&edits, "PATH"), Some(&set("/usr/bin:/bin")));
}

#[test]
fn fully_polluted_path_is_left_untouched() {
    let edits = gated(&[("PATH", "/tmp/.mount_abc/usr/bin:/tmp/.mount_abc/bin")]);
    // Never produce an empty PATH: leave it untouched.
    assert_eq!(find(&edits, "PATH"), None);
}

#[test]
fn xdg_data_dirs_fully_polluted_is_removed() {
    let edits = gated(&[("XDG_DATA_DIRS", "/tmp/.mount_abc/usr/share")]);
    assert_eq!(find(&edits, "XDG_DATA_DIRS"), Some(&EnvEdit::Remove));
}

#[test]
fn pythonpath_and_perllib_filtered() {
    let edits = gated(&[
        ("PYTHONPATH", "/tmp/.mount_abc/usr/lib/python:/home/u/py"),
        ("PERLLIB", "/home/u/perl:/tmp/.mount_abc/usr/lib/perl"),
    ]);
    assert_eq!(find(&edits, "PYTHONPATH"), Some(&set("/home/u/py")));
    assert_eq!(find(&edits, "PERLLIB"), Some(&set("/home/u/perl")));
}

#[test]
fn pythonhome_removed_only_when_under_appdir() {
    let under = gated(&[("PYTHONHOME", "/tmp/.mount_abc/usr")]);
    assert_eq!(find(&under, "PYTHONHOME"), Some(&EnvEdit::Remove));

    let host = gated(&[("PYTHONHOME", "/usr")]);
    assert_eq!(find(&host, "PYTHONHOME"), None);
}

#[test]
fn marker_vars_are_removed() {
    let edits = gated(&[("ARGV0", "termul"), ("OWD", "/home/u")]);
    assert_eq!(find(&edits, "APPDIR"), Some(&EnvEdit::Remove));
    assert_eq!(find(&edits, "APPIMAGE"), Some(&EnvEdit::Remove));
    assert_eq!(find(&edits, "ARGV0"), Some(&EnvEdit::Remove));
    assert_eq!(find(&edits, "OWD"), Some(&EnvEdit::Remove));
}

#[cfg(unix)]
#[test]
fn non_utf8_values_do_not_panic() {
    use std::os::unix::ffi::OsStringExt as _;

    let appdir = OsString::from("/tmp/.mount_abc");
    let bad = OsString::from_vec(vec![b'/', 0xff, b':', b'/', b'u', b's', b'r']);
    let map: HashMap<String, OsString> = [
        ("APPDIR".to_string(), appdir),
        (
            "APPIMAGE".to_string(),
            OsString::from("/home/u/Termul.AppImage"),
        ),
        ("LD_LIBRARY_PATH".to_string(), bad),
    ]
    .into_iter()
    .collect();

    // Must not panic on non-UTF-8 input.
    let edits = plan_appimage_env_cleanup(move |name: &str| map.get(name).cloned());
    // Neither entry is under `$APPDIR`, so LD_LIBRARY_PATH is left untouched.
    assert_eq!(find(&edits, "LD_LIBRARY_PATH"), None);
}

#[test]
fn edits_apply_to_std_command_and_explicit_env_wins() {
    use std::process::Command;

    let plan = gated(&[
        ("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/usr/lib"),
        ("PATH", "/tmp/.mount_abc/usr/bin:/usr/bin"),
    ]);

    let mut command = Command::new("true");
    super::appimage_env::apply_edits(&mut command, &plan);
    // Caller's explicit `.env` lands AFTER the cleanup, so it wins.
    command.env("LD_LIBRARY_PATH", "x");

    let recorded: HashMap<OsString, Option<OsString>> = command
        .get_envs()
        .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
        .collect();

    assert_eq!(
        recorded.get(OsString::from("LD_LIBRARY_PATH").as_os_str()),
        Some(&Some(OsString::from("x")))
    );
    assert_eq!(
        recorded.get(OsString::from("PATH").as_os_str()),
        Some(&Some(OsString::from("/usr/bin")))
    );
    assert_eq!(
        recorded.get(OsString::from("APPDIR").as_os_str()),
        Some(&None)
    );
}

#[cfg(unix)]
#[test]
fn child_sees_cleaned_env_end_to_end() {
    use std::process::Command;

    // Pollute the CHILD command's env (not the process env), then apply the
    // planned edits and confirm the child observes the cleaned values.
    let plan = gated(&[("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/opt/host/lib")]);

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(r#"printf %s "$LD_LIBRARY_PATH|$APPDIR""#)
        .env("LD_LIBRARY_PATH", "/tmp/.mount_abc/usr/lib:/opt/host/lib")
        .env("APPDIR", "/tmp/.mount_abc");

    super::appimage_env::apply_edits(&mut command, &plan);

    let output = command.output().expect("spawn sh");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "/opt/host/lib|");
}
