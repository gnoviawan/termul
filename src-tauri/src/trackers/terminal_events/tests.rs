use super::*;

/// CAP-11: a terminal attaching before any cwd-tracking event sees the
/// spawn-time cwd (seeded), not `null`.
#[test]
fn seed_cwd_fills_absent_snapshot_cwd() {
    let hub = TerminalEventHub::standalone();
    assert_eq!(
        hub.snapshot("t-1").cwd,
        None,
        "unseeded snapshot has no cwd"
    );
    hub.seed_cwd("t-1", "/spawn/dir");
    assert_eq!(hub.snapshot("t-1").cwd.as_deref(), Some("/spawn/dir"));
}

/// CAP-11: the tracked cwd (from a real `CwdChanged` event) always wins —
/// a seed never overrides it, and tracking overrides a prior seed.
#[test]
fn seed_cwd_yields_to_tracked_cwd_in_both_orders() {
    // Tracked first, seed second: the seed must not clobber the tracked cwd.
    let hub = TerminalEventHub::standalone();
    hub.emit(TerminalEvent::CwdChanged {
        terminal_id: "t-1".to_string(),
        cwd: "/tracked".to_string(),
    });
    hub.seed_cwd("t-1", "/spawn/dir");
    assert_eq!(hub.snapshot("t-1").cwd.as_deref(), Some("/tracked"));

    // Seed first, tracked second: the tracking event overrides the seed.
    let hub = TerminalEventHub::standalone();
    hub.seed_cwd("t-2", "/spawn/dir");
    hub.emit(TerminalEvent::CwdChanged {
        terminal_id: "t-2".to_string(),
        cwd: "/tracked".to_string(),
    });
    assert_eq!(hub.snapshot("t-2").cwd.as_deref(), Some("/tracked"));
}
