use super::sign_in::{RequestElicitationRoute, SignInSlot};

fn turn() -> Option<String> {
    Some("chat-1".to_string())
}

#[test]
fn a_url_elicitation_during_authenticate_is_a_sign_in_even_while_a_turn_runs() {
    let mut slot = SignInSlot::default();
    slot.begin_authenticate();
    assert_eq!(slot.route(true, turn()), RequestElicitationRoute::SignIn);
    assert_eq!(slot.route(true, None), RequestElicitationRoute::SignIn);
}

#[test]
fn a_url_elicitation_no_turn_owns_is_a_sign_in() {
    let slot = SignInSlot::default();
    assert_eq!(slot.route(true, None), RequestElicitationRoute::SignIn);
}

#[test]
fn outside_authenticate_the_sole_turn_keeps_request_scoped_elicitations() {
    let slot = SignInSlot::default();
    assert_eq!(
        slot.route(true, turn()),
        RequestElicitationRoute::Session("chat-1".to_string())
    );
    assert_eq!(
        slot.route(false, turn()),
        RequestElicitationRoute::Session("chat-1".to_string())
    );
}

#[test]
fn a_form_elicitation_without_a_turn_is_cancelled_even_during_authenticate() {
    let mut slot = SignInSlot::default();
    assert_eq!(slot.route(false, None), RequestElicitationRoute::Cancel);
    slot.begin_authenticate();
    assert_eq!(slot.route(false, None), RequestElicitationRoute::Cancel);
    assert!(slot.end_authenticate().is_none());
    assert_eq!(
        slot.route(true, turn()),
        RequestElicitationRoute::Session("chat-1".to_string())
    );
}
