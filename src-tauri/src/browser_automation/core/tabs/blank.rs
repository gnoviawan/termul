//! Agent tabs are built at `about:blank`, for which tauri starts no
//! navigation, and sent to their URL once the engine confirmed the
//! webview. Engine adapters attach their own hooks (script dialogs,
//! observers, file choosers) at that confirmation, and a page the
//! webview's first navigation loads can run script before them: WebView2
//! then shows its own dialog and the tab hangs. The blank start loads
//! nothing, so no agent, renderer or consent check ever sees it.

pub const BLANK: &str = "about:blank";

/// How an admitted tab's webview loads its first page.
#[derive(Debug, PartialEq, Eq)]
pub enum FirstLoad {
    /// A user tab is built at its URL.
    Direct(String),
    /// An agent tab is built at [`BLANK`], then navigated to this URL.
    ViaBlank(String),
}

impl FirstLoad {
    /// The URL the webview is built at.
    pub fn build_url(&self) -> &str {
        match self {
            FirstLoad::Direct(url) => url,
            FirstLoad::ViaBlank(_) => BLANK,
        }
    }
}
