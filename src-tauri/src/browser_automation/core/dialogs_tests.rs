use super::*;

#[test]
fn alerts_and_agent_navigation_unloads_close_at_once_everything_else_holds() {
    let table = [
        (DialogKind::Alert, false, Disposition::Accept),
        (DialogKind::Alert, true, Disposition::Accept),
        (DialogKind::BeforeUnload, true, Disposition::Accept),
        (DialogKind::BeforeUnload, false, Disposition::Hold),
        (DialogKind::Confirm, true, Disposition::Hold),
        (DialogKind::Prompt, false, Disposition::Hold),
    ];
    for (kind, navigating, want) in table {
        let mut dialogs = TabDialogs::default();
        assert_eq!(
            dialogs.opened(1, kind, "m", None, navigating),
            want,
            "{kind:?} navigating={navigating}"
        );
    }
}

#[test]
fn a_held_dialog_blocks_until_answered_and_is_reported_while_open() {
    let mut dialogs = TabDialogs::default();
    let watch = dialogs.watch();
    assert_eq!(
        dialogs.opened(7, DialogKind::Prompt, "Name?", Some("Ada"), false),
        Disposition::Hold
    );
    assert!(
        watch.has_changed().unwrap(),
        "holding wakes the in-flight action"
    );
    let open = DialogView {
        kind: "prompt",
        message: "Name?".into(),
        default_text: Some("Ada".into()),
        state: DialogState::Open,
    };
    assert_eq!(dialogs.report(), Some(open.clone()));
    assert_eq!(
        dialogs.report(),
        Some(open),
        "an open dialog is reported on every reply"
    );

    assert_eq!(
        dialogs.opened(8, DialogKind::Confirm, "again?", None, false),
        Disposition::Dismiss
    );
    assert_eq!(
        dialogs.answered(8, true),
        None,
        "only the blocking dialog can be answered"
    );
    let closed = dialogs.answered(7, true).unwrap();
    assert_eq!(closed.state, DialogState::Accepted);
    assert!(dialogs.open().is_none());
    assert_eq!(dialogs.report().map(|v| v.message), Some("again?".into()));
    assert_eq!(dialogs.report(), None, "a closed dialog is reported once");
}

#[test]
fn an_unanswered_dialog_expires_dismissed_and_is_reported_once() {
    let mut dialogs = TabDialogs::default();
    dialogs.opened(3, DialogKind::Confirm, "Delete?", None, false);
    assert!(dialogs.expired(3));
    assert!(!dialogs.expired(3), "already closed");
    assert!(dialogs.open().is_none());
    assert_eq!(
        dialogs.report().map(|v| v.state),
        Some(DialogState::Dismissed)
    );
    assert_eq!(dialogs.report(), None);
}

#[test]
fn dialog_text_is_capped_like_other_page_text() {
    let mut dialogs = TabDialogs::default();
    let long = "x".repeat(100_000);
    dialogs.opened(1, DialogKind::Confirm, &long, None, false);
    let report = dialogs.report().unwrap();
    assert!(report.message.len() < long.len());
}
