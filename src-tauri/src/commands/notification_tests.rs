use super::notification_click_should_focus;

#[test]
fn default_click_focuses_the_window() {
    assert!(notification_click_should_focus("default"));
}

#[test]
fn dismiss_does_not_focus_the_window() {
    assert!(!notification_click_should_focus("__closed"));
    assert!(!notification_click_should_focus(""));
    assert!(!notification_click_should_focus("Show"));
}
