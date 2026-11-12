use super::*;

#[test]
fn agent_strings_travel_as_parameters_never_as_script_source() {
    let hostile = "\"); window.leak = 1; (\"";
    let script = fill("html>body:nth-of-type(1)", hostile);
    assert_eq!(script.helper, FILL);
    assert_eq!(
        script.params,
        json!({ "path": "html>body:nth-of-type(1)", "value": hostile })
    );
    assert!(!script.helper.body.contains(hostile));
}

/// The helpers run in the agent tab while the user types in the chat pane:
/// `focus()` there moves the native first responder on macOS.
#[test]
fn helpers_keep_no_page_visible_state_and_never_move_focus() {
    for helper in [
        SNAPSHOT, RESOLVE, CLICK, FILL, TYPE, PRESS, SCROLL, HOVER, DRAG, SENSITIVITY, CARD_FIELDS, FILE_INPUT,
        OPEN_FILE_CHOOSER, INPUT_FILE_COUNT, WATCH_INPUT_FILES, END_INPUT_WATCH, FACTS,
        PREPARE_TEXT, FOCUSED_EDITABLE, VIEWPORT, SETTLE,
    ] {
        for global in ["window.__", "globalThis", "window[", "localStorage", "sessionStorage"] {
            assert!(!helper.body.contains(global), "{} writes {global}", helper.name);
        }
        assert!(!helper.body.contains(".focus("), "{} moves focus", helper.name);
    }
}

/// The upload ends its watch early by id; both helpers must name the same
/// hook, and keep it off the page world (a symbol key on the agent world's
/// document wrapper, never a string-keyed global).
#[test]
fn an_upload_watch_can_be_ended_by_its_id() {
    let watch = watch_input_files("p", 7, std::time::Duration::from_millis(1500));
    assert_eq!(watch.helper, WATCH_INPUT_FILES);
    assert_eq!(watch.params, json!({ "path": "p", "id": "7", "ms": 1500 }));
    let end = end_input_watch(7);
    assert_eq!(end.helper, END_INPUT_WATCH);
    assert_eq!(end.params, json!({ "id": "7" }));

    let key = "Symbol.for('termul.inputWatches')";
    assert!(WATCH_INPUT_FILES.body.contains(key));
    assert!(END_INPUT_WATCH.body.contains(key));
    assert!(WATCH_INPUT_FILES.body.contains("delete watches[p.id]"), "an ended watch drops its hook");
}

/// The Iris overlay is built only from DOM and CSSOM calls (page CSP and
/// Trusted Types refuse markup and style text), stays out of the page's
/// way, and keeps to the frame budget and the user's motion setting.
#[test]
fn the_agent_overlay_is_inert_markup_free_and_frame_budgeted() {
    let js = AGENT_OVERLAY;
    for banned in ["innerHTML", "outerHTML", "insertAdjacentHTML", "createElement('style')", "document.write", "eval("] {
        assert!(!js.contains(banned), "overlay uses {banned}");
    }
    assert!(js.contains("window.top !== window"), "main frame only, even where engines inject into subframes");
    assert!(js.contains("mode: 'closed'"), "closed shadow root");
    assert!(js.contains(&format!("var TAG = '{OVERLAY_TAG}'")));
    assert!(js.contains("'pointer-events': 'none'"));
    assert!(js.contains("'z-index': '2147483647'"));
    assert!(js.contains("position: 'fixed'"));
    // Captured at init, before page script can replace them.
    for captured in [
        "window.requestAnimationFrame.bind(window)",
        "HTMLCanvasElement.prototype.getContext",
        "C2D.fillRect",
        "own(C2D, 'fillStyle').set",
    ] {
        assert!(js.contains(captured), "overlay does not capture {captured}");
    }
    assert!(js.contains("var CELL = 8, GAP = 2"));
    assert!(js.contains("var MAX_CELLS = 12000"), "per-frame work is bounded on large viewports");
    assert!(js.contains("var FRAME_MS = 1000 / 30"), "at most 30 fps");
    assert!(js.contains("prefers-reduced-motion: reduce"));
    assert!(js.contains("hiddenOf.call(doc)"), "pauses while the document is hidden");
    assert!(js.contains("PALETTE[floor(ang * HUES) % HUES]"), "cells read cached colours");
    assert!(!js.contains("oklch("), "no colour string is built per cell");
}

#[test]
fn the_overlay_visibility_helper_finds_the_overlay_and_waits_two_frames_to_hide() {
    let restore = crate::browser_automation::budgets::OVERLAY_SELF_RESTORE;
    let restore_ms = u64::try_from(restore.as_millis()).unwrap();
    assert_eq!(overlay_visibility(false).params, json!({ "visible": false, "restoreMs": restore_ms }));
    assert_eq!(overlay_visibility(true).params, json!({ "visible": true, "restoreMs": restore_ms }));
    assert!(
        restore > crate::browser_automation::budgets::ACTION_SCREENSHOT,
        "the overlay never shows itself mid-capture"
    );
    let body = OVERLAY_VISIBILITY.body;
    assert!(body.contains(&format!(":scope > {OVERLAY_TAG}")));
    assert!(body.contains("frame().then(frame)"), "hiding waits for two frames");
    assert!(body.contains("setTimeout(done, 100)"), "but never long on a throttled tab");
    assert!(body.contains("hiddenOf(document)"), "and not at all on a hidden one");
    assert!(body.contains("p.restoreMs"), "a hidden overlay shows itself again");
    assert!(body.contains("clearTimeout(document[RESTORE])"), "a show disarms the self-restore");
    for global in ["window.__", "globalThis", "localStorage"] {
        assert!(!body.contains(global));
    }
}

#[test]
fn the_frame_and_overlay_probes_read_what_they_name() {
    assert_eq!(frame_sources().params, json!({}));
    for tag in ["'iframe, ", " frame, ", " embed, ", " object'"] {
        assert!(FRAME_SOURCES.body.contains(tag), "frame sources misses {tag}");
    }
    assert!(FRAME_SOURCES.body.contains("deepAll(document,"), "shadow roots and same-origin frames count");
    assert!(OVERLAY_STATE.body.contains(&format!(":scope > {OVERLAY_TAG}")));
    assert_eq!(overlay_state().helper, OVERLAY_STATE);
}

/// Only agent tabs run the overlay: the hook installs it past the user-tab
/// return.
#[test]
fn only_agent_tabs_get_the_overlay_script() {
    let hooks = include_str!("hooks.rs");
    let user_return = hooks.find("if events.role() != TabRole::Agent").expect("role gate");
    let overlay = hooks
        .find("initialization_script(super::assets::AGENT_OVERLAY)")
        .expect("overlay hook");
    assert!(overlay > user_return, "the overlay is installed after the user-tab return");
}
