//! Local `file://` pages on agent tabs: a page in the project opens without
//! a prompt and loads by its real path; an iframe on it that points at a
//! file it holds no grant for is blocked (the page also embeds the file as
//! an `<object>`; the case checks that the file's text never reaches the
//! outline, not how the engine renders the object); the agent's screenshot
//! of it works; secrets are refused and a file outside the project asks. A
//! file page's link to another project page loads; one to an outside file
//! stays cancelled and is reported (on macOS WKWebView refuses it before the
//! host's hook runs, so the case checks the tab stayed put instead). The agent overlay is mounted once,
//! found by the hide, absent from the agent's capture and showing again
//! after it.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use termul_manager_lib::conformance_support as host;

use super::{mismatch, read_png, tab_id, CaseResult, Ctx};

#[path = "png_probe.rs"]
mod png_probe;
use crate::adapter::SECRET_FILE;
use crate::sensitive_cases::{expect_refusal, expect_tickets};

const FILE_PAGE_READY: &str = "File page ready";
const EMBED_BLOCKED: &str = "Embed blocked";
/// The outside file's text: never readable through the page.
const OUTSIDE_TEXT: &str = "fake file outside the project";

fn file_url(path: &Path) -> String {
    tauri::Url::from_file_path(path)
        .map(|url| url.to_string())
        .unwrap_or_default()
}

/// The page reports whether its iframe kept its empty start document (the
/// guard cancelled the file load) or loaded something else.
fn page(embed: &str) -> String {
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>File page</title></head>
<body>
<h1>{FILE_PAGE_READY}</h1>
<p id="state">Embed pending</p>
<iframe title="Embedded file" src="{embed}"></iframe>
<object title="Embedded object" data="{embed}"></object>
<script>
addEventListener('load', function () {{
  var state = 'Embed loaded';
  try {{
    var d = document.querySelector('iframe').contentDocument;
    if (d && (d.URL === 'about:blank' || d.URL === '')) state = '{EMBED_BLOCKED}';
  }} catch (e) {{}}
  document.getElementById('state').textContent = state;
}});
</script>
</body></html>
"#
    )
}

pub async fn file_pages(c: &Ctx<'_>) -> CaseResult {
    let outside = c.engine.outside_file();
    let index = c.engine.write_project_page("site/index.html", &page(&file_url(&outside)));
    let reply = c.call("navigate", json!({ "url": file_url(&index) })).await?;
    expect_tickets(c, &[], "a project page")?;
    let landed = reply["page"]["url"].as_str().unwrap_or_default();
    if !landed.starts_with("file://") {
        return Err(mismatch(format!("the project page landed on {landed}")));
    }
    c.call("wait", json!({ "text": FILE_PAGE_READY })).await?;
    c.call("wait", json!({ "text": EMBED_BLOCKED })).await?;
    let outline = c.snapshot().await?.text;
    if outline.contains(OUTSIDE_TEXT) {
        return Err(mismatch("a file the page holds no grant for was readable through it"));
    }

    let shot = c.call("screenshot", json!({})).await?;
    read_png(&shot)?;

    expect_refusal(
        c.call("navigate", json!({ "url": file_url(&c.engine.project_file(SECRET_FILE)) })).await,
        "invalid_params",
        "secret_file",
        "a secret in the project",
    )?;
    expect_refusal(
        c.call("navigate", json!({ "url": file_url(&outside) })).await,
        "confirmation_required",
        "unattended",
        "a file outside the project",
    )?;
    let raised = c.engine.tickets(&c.session);
    if raised.len() != 1 {
        return Err(mismatch(format!("expected one file ticket, got {}", raised.len())));
    }
    Ok(())
}

const ABOUT_READY: &str = "About page ready";
/// WKWebView loads a file page with read access to the project folder and
/// refuses a link outside it on its own, before the host's navigation hook
/// sees it, so no `page.fileLinks` note follows; the tab stays put. Every
/// other engine hands the hop to the hook, which reports it.
const ENGINE_REFUSES_OUTSIDE_FILE_LINKS: bool = cfg!(target_os = "macos");
/// How long the case watches a WKWebView tab for a note that never comes.
const WEBKIT_LINK_WAIT: Duration = Duration::from_secs(3);
/// How long the iris may take to close on a new page.
const OVERLAY_WAIT: Duration = Duration::from_secs(5);
/// The square sampled at each corner of a capture, and its inset.
const CORNER: usize = 48;
const CORNER_INSET: usize = 4;
const LINK_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

/// A file page's own links: one to another project page is checked off
/// the UI thread and loads; one to a file outside the project stays
/// cancelled, and a later reply tells the agent to navigate there itself.
pub async fn file_link_hops(c: &Ctx<'_>) -> CaseResult {
    let outside = file_url(&c.engine.outside_file());
    c.engine.write_project_page(
        "links/about.html",
        &format!("<!doctype html><title>About</title><h1>{ABOUT_READY}</h1>"),
    );
    let index = c.engine.write_project_page(
        "links/index.html",
        &format!(
            "<!doctype html><title>Links</title><h1>Links page ready</h1>\
             <p><a href=\"about.html\">About</a></p><p><a href=\"{outside}\">Outside</a></p>"
        ),
    );
    c.call("navigate", json!({ "url": file_url(&index) })).await?;
    c.call("wait", json!({ "text": "Links page ready" })).await?;

    let outside_link = c.ref_of("link", "Outside").await?;
    // The check may finish before the click replies, which then reports it.
    let mut reply = c.call("click", json!({ "ref": outside_link })).await?;
    let until = Instant::now() + if ENGINE_REFUSES_OUTSIDE_FILE_LINKS { WEBKIT_LINK_WAIT } else { LINK_WAIT };
    loop {
        let links = &reply["page"]["fileLinks"];
        if links[0]["url"].is_string() {
            if links[0]["reason"] != "outside_project" {
                return Err(mismatch(format!("outside link reported as {links}")));
            }
            break;
        }
        if Instant::now() > until {
            if !ENGINE_REFUSES_OUTSIDE_FILE_LINKS {
                return Err(mismatch("the cancelled outside link was never reported"));
            }
            // WKWebView refuses the hop itself (outside the page's read
            // access) before the navigation hook runs: nothing to report,
            // and nothing may have loaded.
            let snap = c.snapshot().await?;
            if !snap.text.contains("Links page ready") {
                return Err(mismatch(format!("the refused outside link left the page: {}", snap.text)));
            }
            break;
        }
        tokio::time::sleep(POLL).await;
        reply = c.call("snapshot", json!({})).await?;
    }
    expect_tickets(c, &[], "a link never prompts")?;

    c.click("link", "About").await?;
    c.call("wait", json!({ "text": ABOUT_READY })).await?;
    expect_tickets(c, &[], "a project link opens without a prompt")
}

/// Exactly one overlay hangs off an agent page's `<html>`; hiding it
/// finds it; a screenshot leaves it showing again.
pub async fn agent_overlay(c: &Ctx<'_>) -> CaseResult {
    let white = c.engine.write_project_page(
        "white/index.html",
        "<!doctype html><html style=\"background:#fff\"><head><title>White</title></head>\
         <body style=\"margin:0;background:#fff\"><p style=\"margin:45vh 0 0;text-align:center\">White page ready</p></body></html>",
    );
    let reply = c.call("new_tab", json!({ "url": file_url(&white) })).await?;
    let tab = tab_id(&reply)?;
    c.call("wait", json!({ "text": "White page ready" })).await?;
    let state = overlay_state(c, &tab).await?;
    if state["count"] != 1 || state["visible"] != true {
        return Err(mismatch(format!("before the capture the overlay is {state}")));
    }
    // Control: a raw engine capture, which nothing hides the overlay for,
    // shows the grid in the corners once the iris has closed.
    let until = Instant::now() + OVERLAY_WAIT;
    loop {
        let raw = c
            .engine
            .input()
            .screenshot(&tab)
            .await
            .map_err(|e| mismatch(format!("raw capture failed: {:?}", e.kind)))?;
        let image = png_probe::decode(&raw).map_err(mismatch)?;
        if image.non_white_corner_pixels(CORNER, CORNER_INSET) > 0 {
            break;
        }
        if Instant::now() > until {
            return Err(mismatch("the overlay never drew in the corners of a raw capture"));
        }
        tokio::time::sleep(POLL).await;
    }
    let hidden = c
        .engine
        .input()
        .evaluate(&tab, host::overlay_visibility(false))
        .await
        .map_err(|e| mismatch(format!("overlay hide failed: {:?}", e.kind)))?;
    if hidden["found"].as_u64().unwrap_or(0) < 1 {
        return Err(mismatch(format!("the hide found no overlay: {hidden}")));
    }
    c.engine
        .input()
        .evaluate(&tab, host::overlay_visibility(true))
        .await
        .map_err(|e| mismatch(format!("overlay show failed: {:?}", e.kind)))?;
    // The agent's capture hides it: the corners are plain page.
    let shot = c.call("screenshot", json!({})).await?;
    read_png(&shot)?;
    let path = shot["data"]["path"].as_str().unwrap_or_default();
    let bytes = std::fs::read(path).map_err(|e| mismatch(format!("screenshot unreadable: {e}")))?;
    let image = png_probe::decode(&bytes).map_err(mismatch)?;
    let stray = image.non_white_corner_pixels(CORNER, CORNER_INSET);
    if stray > 0 {
        return Err(mismatch(format!(
            "the agent's capture shows the overlay: {stray} non-white corner pixels of {}x{}",
            image.width, image.height
        )));
    }
    let state = overlay_state(c, &tab).await?;
    if state["count"] != 1 || state["visible"] != true {
        return Err(mismatch(format!("after the capture the overlay is {state}")));
    }
    Ok(())
}

async fn overlay_state(c: &Ctx<'_>, tab: &str) -> Result<serde_json::Value, super::Failure> {
    c.engine
        .input()
        .evaluate(tab, host::overlay_state())
        .await
        .map_err(|e| mismatch(format!("overlay probe failed: {:?}", e.kind)))
}
