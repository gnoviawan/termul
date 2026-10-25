//! Mermaid diagrams for the chat transcript. GPUIX has no DOM for mermaid to lay out in, so a
//! hidden webview (an offscreen GTK window, never attached to the app window) runs mermaid at
//! the version the web client bundles, rasterizes each diagram through a canvas, and posts the PNG
//! back as a data URL. The page and the script come from the `termul-mermaid:` scheme; renders
//! that arrive before the page has loaded wait in `queue`.

use std::borrow::Cow;

use gtk::prelude::*;
use wry::http::Response;
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtUnix};

const SCHEME: &str = "termul-mermaid";
const PAGE_URL: &str = "termul-mermaid://localhost/";
const PAGE_HTML: &str = include_str!("mermaid.html");
/// The web client's own copy (the repo's `node_modules`), so both draw with one mermaid.
const MERMAID_JS: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../node_modules/mermaid/dist/mermaid.min.js"));

fn response(path: &str) -> Response<Cow<'static, [u8]>> {
    let (body, kind): (&'static [u8], &str) = match path {
        "/mermaid.min.js" => (MERMAID_JS, "text/javascript; charset=utf-8"),
        _ => (PAGE_HTML.as_bytes(), "text/html; charset=utf-8"),
    };
    Response::builder().header("Content-Type", kind).body(Cow::Borrowed(body)).expect("static mermaid response")
}

pub struct Renderer {
    view: WebView,
    _window: gtk::OffscreenWindow,
    ready: bool,
    queue: Vec<(String, String)>,
}

impl Renderer {
    pub fn new(context: &mut WebContext, on_message: impl Fn(&str) + 'static) -> Result<Self, String> {
        let window = gtk::OffscreenWindow::new();
        // Room for a wide diagram: mermaid measures its labels in this viewport.
        window.set_default_size(1600, 1200);
        let register = !context.is_custom_protocol_registered(SCHEME);
        let builder = WebViewBuilder::new_with_web_context(context)
            .with_url(PAGE_URL)
            .with_ipc_handler(move |request| on_message(request.body()));
        let builder = if register {
            builder.with_custom_protocol(SCHEME.into(), |_, request| response(request.uri().path()))
        } else {
            builder
        };
        let view = builder.build_gtk(&window).map_err(|e| format!("create mermaid renderer: {e}"))?;
        window.show_all();
        Ok(Self { view, _window: window, ready: false, queue: Vec::new() })
    }

    pub fn render(&mut self, id: String, source: String) -> Result<(), String> {
        if !self.ready {
            self.queue.push((id, source));
            return Ok(());
        }
        let call = format!(
            "window.__termulMermaid.render({}, {})",
            serde_json::to_string(&id).map_err(|e| e.to_string())?,
            serde_json::to_string(&source).map_err(|e| e.to_string())?
        );
        self.view.evaluate_script(&call).map_err(|e| e.to_string())
    }

    pub fn mark_ready(&mut self) -> Vec<String> {
        self.ready = true;
        let mut errors = Vec::new();
        for (id, source) in std::mem::take(&mut self.queue) {
            if let Err(error) = self.render(id.clone(), source) {
                errors.push(format!("{id}: {error}"));
            }
        }
        errors
    }
}
