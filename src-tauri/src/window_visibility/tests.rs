use super::*;

#[test]
fn should_force_show_only_when_hidden_and_not_intentional() {
    assert!(should_force_show(false, false, false));
    assert!(!should_force_show(true, false, false));
    assert!(!should_force_show(false, true, false));
    assert!(!should_force_show(false, false, true));
    assert!(!should_force_show(true, true, true));
}

#[cfg(target_os = "linux")]
#[test]
fn wayland_detected_from_session_type_or_display() {
    assert!(is_wayland_from_env(Some("wayland"), None));
    assert!(is_wayland_from_env(Some("Wayland"), Some("")));
    assert!(is_wayland_from_env(None, Some("wayland-1")));
    assert!(!is_wayland_from_env(Some("x11"), Some("wayland-0")));
    assert!(is_wayland_from_env(Some(""), Some("wayland-0")));
    assert!(!is_wayland_from_env(Some("x11"), None));
    assert!(!is_wayland_from_env(None, None));
    assert!(!is_wayland_from_env(Some(""), Some("  ")));
}

#[cfg(not(target_os = "linux"))]
#[test]
fn wayland_always_false_off_linux() {
    assert!(!is_wayland_from_env(Some("wayland"), Some("wayland-0")));
    assert!(!is_wayland_from_env(None, Some("wayland-1")));
}
