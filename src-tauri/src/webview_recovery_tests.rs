use super::*;

fn secs(start: Instant, offset: u64) -> Instant {
    start + Duration::from_secs(offset)
}

#[test]
fn render_crash_or_hang_reloads() {
    for kind in [KIND_RENDER_PROCESS_EXITED, KIND_RENDER_PROCESS_UNRESPONSIVE] {
        let mut state = RecoveryState::new();
        assert_eq!(
            decide(kind, &mut state, Instant::now(), false),
            Effect::Reload,
            "{}",
            kind_name(kind)
        );
        assert!(!state.restart_requested());
    }
}

#[test]
fn render_events_within_the_cooldown_are_deduped_without_spending_budget() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    assert_eq!(
        decide(KIND_RENDER_PROCESS_UNRESPONSIVE, &mut state, start, false),
        Effect::Reload
    );
    // One hang reports repeatedly: every event inside 15 s is dropped.
    for offset in [1, 5, 14] {
        assert_eq!(
            decide(
                KIND_RENDER_PROCESS_UNRESPONSIVE,
                &mut state,
                secs(start, offset),
                false
            ),
            Effect::None
        );
    }
    // The deduped events did not consume budget: two more reloads fit.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 15),
            false
        ),
        Effect::Reload
    );
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 30),
            false
        ),
        Effect::Reload
    );
}

#[test]
fn spent_reload_budget_escalates_to_one_restart() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    for offset in [0, 20, 40] {
        assert_eq!(
            decide(
                KIND_RENDER_PROCESS_EXITED,
                &mut state,
                secs(start, offset),
                false
            ),
            Effect::Reload
        );
    }
    // Fourth reload due inside 300 s: escalate.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 60),
            false
        ),
        Effect::Restart
    );
    assert!(state.restart_requested());
    // Never a second restart, and no reloads once restarting.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 400),
            false
        ),
        Effect::None
    );
    assert_eq!(
        decide(
            KIND_BROWSER_PROCESS_EXITED,
            &mut state,
            secs(start, 401),
            false
        ),
        Effect::None
    );
}

#[test]
fn reload_budget_slides_with_the_window() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    for offset in [0, 20, 40] {
        assert_eq!(
            decide(
                KIND_RENDER_PROCESS_EXITED,
                &mut state,
                secs(start, offset),
                false
            ),
            Effect::Reload
        );
    }
    // The first reload ages out at exactly 300 s.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 300),
            false
        ),
        Effect::Reload
    );
    assert!(!state.restart_requested());
}

#[test]
fn browser_process_exit_restarts_once() {
    let mut state = RecoveryState::new();
    let now = Instant::now();
    assert_eq!(
        decide(KIND_BROWSER_PROCESS_EXITED, &mut state, now, false),
        Effect::Restart
    );
    assert_eq!(
        decide(KIND_BROWSER_PROCESS_EXITED, &mut state, now, false),
        Effect::None
    );
}

#[test]
fn browser_process_exit_is_not_deduped_by_a_recent_reload() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    assert_eq!(
        decide(KIND_RENDER_PROCESS_EXITED, &mut state, start, false),
        Effect::Reload
    );
    assert_eq!(
        decide(
            KIND_BROWSER_PROCESS_EXITED,
            &mut state,
            secs(start, 1),
            false
        ),
        Effect::Restart
    );
}

#[test]
fn iframe_and_auxiliary_process_exits_are_log_only() {
    let mut state = RecoveryState::new();
    let now = Instant::now();
    for kind in [
        KIND_FRAME_RENDER_PROCESS_EXITED,
        KIND_UTILITY_PROCESS_EXITED,
        KIND_SANDBOX_HELPER_PROCESS_EXITED,
        KIND_GPU_PROCESS_EXITED,
        7,
        42,
        -1,
    ] {
        assert_eq!(
            decide(kind, &mut state, now, false),
            Effect::None,
            "kind {kind}"
        );
    }
    // Log-only kinds touch no state: the full budget is still there.
    for offset in [0, 20, 40] {
        assert_eq!(
            decide(
                KIND_RENDER_PROCESS_EXITED,
                &mut state,
                secs(now, offset),
                false
            ),
            Effect::Reload
        );
    }
}

#[test]
fn no_action_while_the_app_is_exiting() {
    let now = Instant::now();
    for kind in [
        KIND_BROWSER_PROCESS_EXITED,
        KIND_RENDER_PROCESS_EXITED,
        KIND_RENDER_PROCESS_UNRESPONSIVE,
        KIND_FRAME_RENDER_PROCESS_EXITED,
        KIND_GPU_PROCESS_EXITED,
    ] {
        let mut state = RecoveryState::new();
        assert_eq!(
            decide(kind, &mut state, now, true),
            Effect::None,
            "{}",
            kind_name(kind)
        );
        assert!(!state.restart_requested());
    }
}

#[test]
fn outcome_notes_name_the_reason() {
    assert_eq!(
        outcome_note(KIND_RENDER_PROCESS_EXITED, Effect::Reload, false, false),
        "reloading"
    );
    assert!(
        outcome_note(KIND_RENDER_PROCESS_EXITED, Effect::Restart, false, false)
            .starts_with("reload budget spent")
    );
    assert!(
        outcome_note(KIND_BROWSER_PROCESS_EXITED, Effect::Restart, false, false)
            .starts_with("restarting")
    );
    assert!(
        outcome_note(KIND_BROWSER_PROCESS_EXITED, Effect::None, false, true)
            .starts_with("app is exiting")
    );
    assert!(
        outcome_note(KIND_RENDER_PROCESS_EXITED, Effect::None, true, false)
            .starts_with("restart already decided")
    );
    assert!(
        outcome_note(KIND_RENDER_PROCESS_UNRESPONSIVE, Effect::None, false, false)
            .contains("deduped")
    );
    assert!(
        outcome_note(KIND_GPU_PROCESS_EXITED, Effect::None, false, false).starts_with("log only")
    );
}

#[test]
fn kind_names_are_logged_verbatim() {
    assert_eq!(
        kind_name(KIND_BROWSER_PROCESS_EXITED),
        "BROWSER_PROCESS_EXITED"
    );
    assert_eq!(
        kind_name(KIND_RENDER_PROCESS_UNRESPONSIVE),
        "RENDER_PROCESS_UNRESPONSIVE"
    );
    assert_eq!(
        kind_name(KIND_FRAME_RENDER_PROCESS_EXITED),
        "FRAME_RENDER_PROCESS_EXITED"
    );
    assert_eq!(kind_name(KIND_GPU_PROCESS_EXITED), "GPU_PROCESS_EXITED");
    assert_eq!(kind_name(42), "OTHER_PROCESS_EXITED");
}

#[test]
fn a_render_crash_right_after_a_reload_still_reloads() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    assert_eq!(
        decide(KIND_RENDER_PROCESS_EXITED, &mut state, start, false),
        Effect::Reload
    );
    // A crash fires once: deduping it would leave the page dead.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 2),
            false
        ),
        Effect::Reload
    );
    // A hang inside the cooldown of that reload is still deduped.
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_UNRESPONSIVE,
            &mut state,
            secs(start, 3),
            false
        ),
        Effect::None
    );
}

#[test]
fn a_failed_reload_escalates_to_one_restart() {
    let mut state = RecoveryState::new();
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            Instant::now(),
            false
        ),
        Effect::Reload
    );
    assert_eq!(on_reload_failed(&mut state), Effect::Restart);
    assert!(state.restart_requested());
    assert_eq!(on_reload_failed(&mut state), Effect::None);
    assert_eq!(
        decide(
            KIND_BROWSER_PROCESS_EXITED,
            &mut state,
            Instant::now(),
            false
        ),
        Effect::None
    );
}

#[test]
fn a_failed_reload_after_a_restart_decision_does_nothing() {
    let mut state = RecoveryState::new();
    assert_eq!(
        decide(
            KIND_BROWSER_PROCESS_EXITED,
            &mut state,
            Instant::now(),
            false
        ),
        Effect::Restart
    );
    assert_eq!(on_reload_failed(&mut state), Effect::None);
}

#[test]
fn restart_guard_blocks_within_ten_minutes_of_the_last_restart() {
    let now = 1_800_000_000;
    let guard = RESTART_GUARD.as_secs();
    let cases = [
        (None, true, "no marker"),
        (Some(now), false, "restarted just now"),
        (Some(now - (guard - 1)), false, "inside the guard"),
        (Some(now - guard), true, "guard elapsed"),
        (Some(0), true, "long ago"),
        (Some(now + 5), true, "marker in the future is garbled"),
    ];
    for (marker, allowed, case) in cases {
        assert_eq!(restart_allowed(marker, now), allowed, "{case}");
    }
}

#[test]
fn garbled_markers_parse_as_no_guard() {
    assert_eq!(parse_marker("1800000000"), Some(1_800_000_000));
    assert_eq!(parse_marker(" 1800000000\r\n"), Some(1_800_000_000));
    for garbled in ["", "soon", "-5", "12.5", "\u{0}\u{0}"] {
        assert_eq!(parse_marker(garbled), None, "{garbled:?}");
    }
}

#[test]
fn an_undispatched_restart_falls_back_to_reloads() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    for offset in [0, 20, 40] {
        assert_eq!(
            decide(
                KIND_RENDER_PROCESS_EXITED,
                &mut state,
                secs(start, offset),
                false
            ),
            Effect::Reload
        );
    }
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 60),
            false
        ),
        Effect::Restart
    );
    // The guard refused it: recovery must not go quiet.
    state.restart_not_dispatched();
    assert!(!state.restart_requested());
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 300),
            false
        ),
        Effect::Reload
    );
    assert_eq!(
        decide(
            KIND_BROWSER_PROCESS_EXITED,
            &mut state,
            secs(start, 301),
            false
        ),
        Effect::Restart
    );
}

#[test]
fn claim_restart_writes_the_marker_when_none_exists() {
    let dir = tempfile::tempdir().unwrap();
    let marker = marker_path(dir.path());
    assert_eq!(marker.file_name().unwrap(), RESTART_MARKER_FILE);
    assert_eq!(claim_restart(&marker, 1_800_000_000), Ok(true));
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "1800000000");
}

#[test]
fn claim_restart_refuses_inside_the_guard_and_keeps_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let marker = marker_path(dir.path());
    let last = 1_800_000_000u64;
    std::fs::write(&marker, last.to_string()).unwrap();
    let now = last + RESTART_GUARD.as_secs() - 1;
    assert_eq!(claim_restart(&marker, now), Ok(false));
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), last.to_string());
}

#[test]
fn claim_restart_rewrites_a_stale_marker() {
    let dir = tempfile::tempdir().unwrap();
    let marker = marker_path(dir.path());
    let last = 1_800_000_000u64;
    std::fs::write(&marker, last.to_string()).unwrap();
    let now = last + RESTART_GUARD.as_secs();
    assert_eq!(claim_restart(&marker, now), Ok(true));
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), now.to_string());
}

#[test]
fn claim_restart_fails_when_the_marker_cannot_be_written() {
    let dir = tempfile::tempdir().unwrap();
    let marker = marker_path(dir.path());
    std::fs::create_dir(&marker).unwrap();
    assert!(claim_restart(&marker, 1_800_000_000).is_err());
}

#[test]
fn a_refused_restart_gets_one_fallback_reload_per_window() {
    let start = Instant::now();
    let mut state = RecoveryState::new();
    // Budget spent, restart decided, then refused by the guard.
    for offset in [0, 20, 40] {
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, offset),
            false,
        );
    }
    assert_eq!(
        decide(
            KIND_RENDER_PROCESS_EXITED,
            &mut state,
            secs(start, 60),
            false
        ),
        Effect::Restart
    );
    state.restart_not_dispatched();
    assert!(fallback_reload(
        KIND_RENDER_PROCESS_EXITED,
        &mut state,
        secs(start, 60),
        false
    ));
    // A crash loop does not get a second over-budget reload inside the window...
    assert!(!fallback_reload(
        KIND_RENDER_PROCESS_EXITED,
        &mut state,
        secs(start, 120),
        false
    ));
    // ...but does once the window has passed.
    assert!(fallback_reload(
        KIND_RENDER_PROCESS_UNRESPONSIVE,
        &mut state,
        secs(start, 360),
        false
    ));
}

#[test]
fn no_fallback_reload_while_exiting_or_for_non_render_kinds() {
    let now = Instant::now();
    let mut state = RecoveryState::new();
    assert!(!fallback_reload(
        KIND_RENDER_PROCESS_EXITED,
        &mut state,
        now,
        true
    ));
    for kind in [
        KIND_BROWSER_PROCESS_EXITED,
        KIND_FRAME_RENDER_PROCESS_EXITED,
        KIND_GPU_PROCESS_EXITED,
    ] {
        assert!(
            !fallback_reload(kind, &mut state, now, false),
            "{}",
            kind_name(kind)
        );
    }
    // Nothing above consumed the fallback.
    assert!(fallback_reload(
        KIND_RENDER_PROCESS_EXITED,
        &mut state,
        now,
        false
    ));
}
