//! WebKitGTK script dialogs on agent tabs: `script-dialog` handled
//! asynchronously, keeping a reference to the dialog until the core
//! answers and closing it then.

use webkit2gtk::{ScriptDialog, ScriptDialogType, WebView, WebViewExt};

use crate::browser_automation::engine::dialogs::{self, HeldDialog};
use crate::browser_automation::engine::events::{DialogAnswer, DialogKind, TabEvents};

fn kind_of(kind: ScriptDialogType) -> Option<DialogKind> {
    match kind {
        ScriptDialogType::Alert => Some(DialogKind::Alert),
        ScriptDialogType::Confirm => Some(DialogKind::Confirm),
        ScriptDialogType::Prompt => Some(DialogKind::Prompt),
        ScriptDialogType::BeforeUnloadConfirm => Some(DialogKind::BeforeUnload),
        _ => None,
    }
}

fn complete(dialog: &ScriptDialog, kind: DialogKind, answer: &DialogAnswer) {
    let accepted = matches!(answer, DialogAnswer::Accept { .. });
    match (kind, answer) {
        (DialogKind::Confirm | DialogKind::BeforeUnload, _) => {
            dialog.confirm_set_confirmed(accepted)
        }
        // An unset prompt result returns null, as Cancel does.
        (DialogKind::Prompt, DialogAnswer::Accept { text }) => {
            dialog.prompt_set_text(text.as_deref().unwrap_or_default());
        }
        _ => {}
    }
    dialog.close();
}

pub fn attach(webview: &WebView, events: TabEvents) {
    webview.connect_script_dialog(move |_, dialog| {
        let Some(kind) = kind_of(dialog.dialog_type()) else {
            return false;
        };
        let message = dialog.message().map(|m| m.to_string()).unwrap_or_default();
        let default_text = (kind == DialogKind::Prompt).then(|| {
            dialog
                .prompt_get_default_text()
                .map(|t| t.to_string())
                .unwrap_or_default()
        });
        let id = events.dialog_opened(kind, message, default_text);
        let held = dialog.clone();
        dialogs::hold(
            events.label(),
            id,
            HeldDialog::new(move |answer| complete(&held, kind, answer)),
        );
        true
    });
}
