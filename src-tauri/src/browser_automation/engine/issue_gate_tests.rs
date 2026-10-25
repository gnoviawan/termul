use super::*;

#[test]
fn a_closure_that_claims_first_wins_and_the_timeout_loses() {
    let gate = IssueGate::new();
    assert!(gate.claim());
    assert!(!gate.cancel());
}

#[test]
fn a_timeout_that_cancels_first_stops_the_closure_for_good() {
    let gate = IssueGate::new();
    assert!(gate.cancel());
    assert!(!gate.claim());
    assert!(!gate.cancel());
}

#[test]
fn dropping_the_guard_cancels_a_pending_closure_but_not_an_issued_one() {
    let dropped = IssueGate::new();
    drop(dropped.cancel_on_drop());
    assert!(!dropped.claim());

    let issued = IssueGate::new();
    let guard = issued.cancel_on_drop();
    assert!(issued.claim());
    drop(guard);
    assert!(!issued.cancel());
}
