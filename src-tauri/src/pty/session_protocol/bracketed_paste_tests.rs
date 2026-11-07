use super::bracketed_paste::BracketedPasteTracker;

#[test]
fn bracketed_paste_defaults_off() {
    let tracker = BracketedPasteTracker::default();
    assert!(!tracker.enabled());
}

#[test]
fn bracketed_paste_turns_on_and_off() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[?2004h");
    assert!(tracker.enabled());
    tracker.observe(b"\x1b[?2004l");
    assert!(!tracker.enabled());
}

#[test]
fn bracketed_paste_sequence_can_split_across_chunks() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[?20");
    assert!(!tracker.enabled());
    tracker.observe(b"04h");
    assert!(tracker.enabled());
    tracker.observe(b"\x1b[?200");
    assert!(tracker.enabled());
    tracker.observe(b"4l");
    assert!(!tracker.enabled());
}

#[test]
fn repeated_esc_still_toggles_bracketed_paste() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b\x1b[?2004h");
    assert!(
        tracker.enabled(),
        "ESC ESC [?2004h must keep ESC as the introducer"
    );
    tracker.observe(b"\x1b\x1b[?2004l");
    assert!(
        !tracker.enabled(),
        "ESC ESC [?2004l must keep ESC as the introducer"
    );
}

#[test]
fn repeated_esc_toggle_can_split_across_chunks() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b");
    assert!(!tracker.enabled());
    tracker.observe(b"\x1b[?2004h");
    assert!(tracker.enabled(), "split ESC ESC [?2004h must enable paste");
    tracker.observe(b"\x1b\x1b[?20");
    assert!(tracker.enabled());
    tracker.observe(b"04l");
    assert!(
        !tracker.enabled(),
        "split ESC ESC [?2004l must disable paste"
    );
}

#[test]
fn bracketed_paste_tracks_2004_among_other_modes() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[?1;2004h");
    assert!(tracker.enabled());
    tracker.observe(b"\x1b[?2004;7l");
    assert!(!tracker.enabled());
}

#[test]
fn public_csi_does_not_enable_bracketed_paste() {
    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[2004h");
    assert!(!tracker.enabled());
}

#[test]
fn ever_enabled_is_sticky() {
    let tracker = BracketedPasteTracker::default();
    assert!(!tracker.ever_enabled());
    tracker.observe(b"\x1b[?2004h");
    assert!(tracker.ever_enabled());
    assert!(tracker.enabled());
    tracker.observe(b"\x1b[?2004l");
    assert!(!tracker.enabled());
    assert!(tracker.ever_enabled(), "ever_enabled remains true");
}

#[tokio::test(start_paused = true)]
async fn wait_for_enabled_wakes_on_off_to_on() {
    use std::sync::Arc;
    use std::time::Duration;

    let tracker = Arc::new(BracketedPasteTracker::default());
    tracker.observe(b"\x1b[?2004h");
    tracker.observe(b"\x1b[?2004l");
    assert!(!tracker.enabled());
    assert!(tracker.ever_enabled());

    let tracker_clone = tracker.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        tracker_clone.observe(b"\x1b[?2004h");
    });

    let enabled = tracker.wait_for_enabled(Duration::from_millis(250)).await;
    assert!(enabled);
    assert!(tracker.enabled());
}

#[tokio::test(start_paused = true)]
async fn wait_for_enabled_times_out_and_returns_false() {
    use std::time::Duration;

    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[?2004h");
    tracker.observe(b"\x1b[?2004l");
    assert!(!tracker.enabled());

    let enabled = tracker.wait_for_enabled(Duration::from_millis(250)).await;
    assert!(!enabled);
    assert!(!tracker.enabled());
}

#[tokio::test(start_paused = true)]
async fn wait_for_enabled_returns_immediately_when_never_enabled() {
    use std::time::Duration;

    let tracker = BracketedPasteTracker::default();
    let start = tokio::time::Instant::now();
    let enabled = tracker.wait_for_enabled(Duration::from_millis(250)).await;
    assert!(!enabled);
    assert_eq!(tokio::time::Instant::now() - start, Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn wait_for_enabled_returns_immediately_when_currently_enabled() {
    use std::time::Duration;

    let tracker = BracketedPasteTracker::default();
    tracker.observe(b"\x1b[?2004h");
    let start = tokio::time::Instant::now();
    let enabled = tracker.wait_for_enabled(Duration::from_millis(250)).await;
    assert!(enabled);
    assert_eq!(tokio::time::Instant::now() - start, Duration::ZERO);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn live_reader_observes_split_modes_as_one_stream() {
    use super::gate::SessionGate;
    use crate::trackers::terminal_events::TerminalEventHub;
    use std::sync::Arc;

    let gate = Arc::new(SessionGate::new(Arc::new(tokio::sync::Mutex::new(None))));
    let mut filter = super::filter::SessionFilter::new();
    let pending = std::sync::Mutex::new(Vec::new());
    let hub = TerminalEventHub::standalone();
    let mut process = |bytes: &[u8]| {
        assert!(super::deliver::process_reader_chunk(
            &mut filter,
            bytes,
            &pending,
            &gate,
            "live",
            &hub,
        ));
        pending.lock().unwrap().drain(..).collect::<Vec<_>>()
    };
    assert_eq!(process(b"\x1b[?20"), b"\x1b[?20");
    assert_eq!(process(b"04h"), b"04h");
    assert!(
        gate.bracketed_paste_enabled(),
        "split DECSET must enable paste"
    );
    process(b"\x1b[?2004l\x1b[?20");
    process(b"04h\x1b[?2004l");
    assert!(!gate.bracketed_paste_enabled(), "the final DECRST wins");
}
