use super::forwarder_should_terminate;

#[test]
fn same_generation_keeps_streaming() {
    assert!(!forwarder_should_terminate(Some(3), Some(3)));
}

#[test]
fn rotated_generation_terminates() {
    assert!(forwarder_should_terminate(Some(3), Some(4)));
    assert!(forwarder_should_terminate(Some(3), Some(2)));
}

#[test]
fn killed_or_reaped_terminal_terminates() {
    assert!(forwarder_should_terminate(Some(3), None));
}

#[test]
fn absent_at_both_ends_is_neutral() {
    assert!(!forwarder_should_terminate(None, None));
    // A forwarder can never start without a record, but the condition must
    // still be total.
    assert!(forwarder_should_terminate(None, Some(1)));
}
