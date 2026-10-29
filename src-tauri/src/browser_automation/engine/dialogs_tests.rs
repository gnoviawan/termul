use std::rc::Rc;

use super::*;

fn recorder() -> (Rc<RefCell<Vec<DialogAnswer>>>, impl Fn() -> HeldDialog) {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let make = {
        let seen = seen.clone();
        move || {
            let seen = seen.clone();
            HeldDialog::new(move |answer| seen.borrow_mut().push(answer.clone()))
        }
    };
    (seen, make)
}

#[test]
fn a_held_dialog_completes_exactly_once_with_the_core_answer() {
    let (seen, make) = recorder();
    hold("agent-a", 1, make());
    let accept = DialogAnswer::Accept {
        text: Some("Ada".into()),
    };
    assert!(answer_held("agent-a", 1, &accept));
    assert!(
        !answer_held("agent-a", 1, &DialogAnswer::Dismiss),
        "already answered"
    );
    assert_eq!(*seen.borrow(), [accept]);
}

#[test]
fn closing_a_tab_dismisses_only_its_own_dialogs() {
    let (seen, make) = recorder();
    hold("agent-a", 1, make());
    hold("agent-b", 1, make());
    release_tab("agent-a");
    assert_eq!(*seen.borrow(), [DialogAnswer::Dismiss]);
    assert!(answer_held("agent-b", 1, &DialogAnswer::Dismiss));
    assert!(!answer_held("agent-a", 1, &DialogAnswer::Dismiss));
}
