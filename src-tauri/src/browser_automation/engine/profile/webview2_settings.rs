//! WebView2 settings for agent tabs, on the UI thread inside `with_webview`.

use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Settings4};
use windows_core::Interface;

/// Turn off the password manager and form autofill for this tab. The
/// runtime's default for password autosave is already off; setting it keeps
/// that true if the default ever changes. Returns false when the runtime
/// predates the settings.
pub fn disable_credential_prompts(core: &ICoreWebView2) -> bool {
    // SAFETY: COM calls on the UI thread that owns `core`.
    unsafe {
        let Ok(settings) = core.Settings() else {
            return false;
        };
        let Ok(settings) = settings.cast::<ICoreWebView2Settings4>() else {
            return false;
        };
        let autosave = settings.SetIsPasswordAutosaveEnabled(false).is_ok();
        let autofill = settings.SetIsGeneralAutofillEnabled(false).is_ok();
        autosave && autofill
    }
}
