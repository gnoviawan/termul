use std::collections::HashMap;

use super::remove_launcher_preload;

const WAYLAND: &str = "/usr/lib/libwayland-client.so.0";

fn terminal_env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    remove_launcher_preload(&mut env);
    env
}

fn preload(env: &HashMap<String, String>) -> Option<&str> {
    env.get("LD_PRELOAD").map(String::as_str)
}

#[test]
fn the_launcher_entry_alone_leaves_no_ld_preload() {
    let env = terminal_env(&[
        ("LD_PRELOAD", WAYLAND),
        ("TERMUL_LAUNCHER_PRELOAD", WAYLAND),
        ("HOME", "/home/u"),
    ]);

    assert_eq!(preload(&env), None);
    assert_eq!(env.get("TERMUL_LAUNCHER_PRELOAD"), None);
    assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
}

#[test]
fn the_users_own_ld_preload_survives_byte_for_byte() {
    let env = terminal_env(&[
        (
            "LD_PRELOAD",
            "/opt/a.so /opt/b.so:/usr/lib/libwayland-client.so.0",
        ),
        ("TERMUL_LAUNCHER_PRELOAD", WAYLAND),
    ]);

    assert_eq!(preload(&env), Some("/opt/a.so /opt/b.so"));
    assert_eq!(env.get("TERMUL_LAUNCHER_PRELOAD"), None);
}

#[test]
fn without_the_marker_ld_preload_is_untouched() {
    let env = terminal_env(&[("LD_PRELOAD", WAYLAND)]);

    assert_eq!(preload(&env), Some(WAYLAND));
}

#[test]
fn a_rewritten_ld_preload_is_left_alone_but_the_marker_goes() {
    let env = terminal_env(&[
        (
            "LD_PRELOAD",
            "/usr/lib/libwayland-client.so.0:/opt/later.so",
        ),
        ("TERMUL_LAUNCHER_PRELOAD", WAYLAND),
    ]);

    assert_eq!(
        preload(&env),
        Some("/usr/lib/libwayland-client.so.0:/opt/later.so")
    );
    assert_eq!(env.get("TERMUL_LAUNCHER_PRELOAD"), None);
}

#[test]
fn a_suffix_that_is_not_a_whole_entry_is_not_removed() {
    let env = terminal_env(&[
        ("LD_PRELOAD", "/opt/x/usr/lib/libwayland-client.so.0"),
        ("TERMUL_LAUNCHER_PRELOAD", WAYLAND),
    ]);

    assert_eq!(preload(&env), Some("/opt/x/usr/lib/libwayland-client.so.0"));
}

#[test]
fn an_empty_marker_leaves_ld_preload_untouched() {
    let env = terminal_env(&[
        ("LD_PRELOAD", "/opt/a.so:"),
        ("TERMUL_LAUNCHER_PRELOAD", ""),
    ]);

    assert_eq!(preload(&env), Some("/opt/a.so:"));
    assert_eq!(env.get("TERMUL_LAUNCHER_PRELOAD"), None);
}
