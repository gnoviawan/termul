//! Deny-by-default web permissions for browser-tab webviews.
//!
//! A browser tab loads arbitrary remote pages and is driven by agents, so no page may
//! reach the camera, microphone, location, notifications, clipboard or any other
//! capability that would otherwise raise a native prompt (or, on macOS, be granted
//! silently when no handler is installed). [`decide`] is the whole policy and answers
//! [`PermissionResponse::Deny`] for every kind, including kinds a later tauri release adds.
//!
//! Coverage per OS comes from the wry permission hook that tauri exposes on
//! `WebviewBuilder::on_permission_request`. WebView2 raises every kind through
//! `PermissionRequested`, WebKitGTK through `permission-request`, and WKWebView through
//! `requestMediaCapturePermission`, so on macOS only camera and microphone reach the
//! handler. Other WKWebView capabilities never reach it, and the app declares no usage
//! descriptions for them.

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Runtime, Webview};

pub(crate) fn decide(_kind: PermissionKind) -> PermissionResponse {
    PermissionResponse::Deny
}

/// Handler for `WebviewBuilder::on_permission_request`. Logs the kind and the tab
/// label only, never the requesting page's URL or content.
pub(crate) fn on_permission_request<R: Runtime>(
    webview: Webview<R>,
    kind: PermissionKind,
) -> PermissionResponse {
    let response = decide(kind);
    log::warn!(
        "[BrowserTab] web permission request kind={} response={} tab={}",
        kind,
        response,
        webview.label()
    );
    response
}

#[cfg(test)]
#[path = "browser_tab_permissions_tests.rs"]
mod tests;
