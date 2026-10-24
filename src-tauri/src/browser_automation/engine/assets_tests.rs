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
        SNAPSHOT, RESOLVE, CLICK, FILL, TYPE, PRESS, SCROLL, HOVER, DRAG, SENSITIVITY, FILE_INPUT, OPEN_FILE_CHOOSER, FACTS,
        PREPARE_TEXT, FOCUSED_EDITABLE, VIEWPORT, SETTLE,
    ] {
        for global in ["window.__", "globalThis", "window[", "localStorage", "sessionStorage"] {
            assert!(!helper.body.contains(global), "{} writes {global}", helper.name);
        }
        assert!(!helper.body.contains(".focus("), "{} moves focus", helper.name);
    }
}
