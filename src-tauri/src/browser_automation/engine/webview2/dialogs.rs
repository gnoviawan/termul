//! WebView2 script dialogs on agent tabs: default dialogs off, and every
//! `ScriptDialogOpening` deferred until the core answers it.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ScriptDialogOpeningEventArgs, COREWEBVIEW2_SCRIPT_DIALOG_KIND,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM, COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
};
use webview2_com::{take_pwstr, ScriptDialogOpeningEventHandler};
use windows_core::{HSTRING, PWSTR};

use crate::browser_automation::engine::dialogs::{self, HeldDialog};
use crate::browser_automation::engine::events::{DialogAnswer, DialogKind, TabEvents};

fn kind_of(kind: COREWEBVIEW2_SCRIPT_DIALOG_KIND) -> Option<DialogKind> {
    match kind {
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT => Some(DialogKind::Alert),
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM => Some(DialogKind::Confirm),
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT => Some(DialogKind::Prompt),
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD => Some(DialogKind::BeforeUnload),
        _ => None,
    }
}

fn read(get: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> String {
    let mut text = PWSTR::null();
    match get(&mut text) {
        Ok(()) => take_pwstr(text),
        Err(_) => String::new(),
    }
}

fn complete(args: &ICoreWebView2ScriptDialogOpeningEventArgs, answer: &DialogAnswer) {
    // SAFETY: COM calls on the event's own args, on the UI thread that
    // raised the event (held dialogs are completed there).
    unsafe {
        if let DialogAnswer::Accept { text } = answer {
            if let Some(text) = text {
                let _ = args.SetResultText(&HSTRING::from(text.as_str()));
            }
            let _ = args.Accept();
        }
    }
}

/// Turn the default dialogs off and hold each dialog for the core.
pub fn attach(core: &ICoreWebView2, events: &TabEvents) -> bool {
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    let disabled = unsafe {
        core.Settings()
            .and_then(|settings| settings.SetAreDefaultScriptDialogsEnabled(false))
    };
    if disabled.is_err() {
        return false;
    }
    let events = events.clone();
    let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut raw = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
        // SAFETY: COM calls on the event's own args, on the UI thread.
        unsafe { args.Kind(&mut raw)? };
        // An unknown kind is left alone: without a deferral or Accept,
        // WebView2 cancels it when this handler returns.
        let Some(kind) = kind_of(raw) else {
            return Ok(());
        };
        // SAFETY: as above.
        let message = read(|out| unsafe { args.Message(out) });
        let default_text =
            (kind == DialogKind::Prompt).then(|| read(|out| unsafe { args.DefaultText(out) }));
        // SAFETY: as above.
        let deferral = unsafe { args.GetDeferral()? };
        let id = events.dialog_opened(kind, message, default_text);
        dialogs::hold(
            events.label(),
            id,
            HeldDialog::new(move |answer| {
                complete(&args, answer);
                // SAFETY: as above.
                let _ = unsafe { deferral.Complete() };
            }),
        );
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: as above.
    unsafe { core.add_ScriptDialogOpening(&handler, &mut token) }.is_ok()
}
