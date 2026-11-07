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
