//! WebKitGTK file choosers on agent tabs: `run-file-chooser` answered with
//! the files an upload staged, or cancelled, so the GTK dialog never opens.

use webkit2gtk::{FileChooserRequestExt, WebView, WebViewExt};

use crate::browser_automation::engine::file_chooser;

pub fn attach(webview: &WebView, label: String) {
    webview.connect_run_file_chooser(move |_, request| {
        match file_chooser::answer(&label) {
            Some(files) => {
                let paths: Vec<String> = files
                    .iter()
                    .map(|file| file.to_string_lossy().into_owned())
                    .collect();
                let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
                request.select_files(&paths);
            }
            None => {
                log::info!("[browser-tab] page file chooser cancelled on an agent tab");
                request.cancel();
            }
        }
        true
    });
}
