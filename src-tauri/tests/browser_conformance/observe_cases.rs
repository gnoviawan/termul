//! Cases for console and network observation. Each checks the entries a
//! fixture page produced, that a cursor pages past them, and that no URL
//! in a reply carries the query strings the page used. And reading a page
//! whose text is longer than the snapshot shows, which must neither push
//! controls out of the snapshot nor scroll the page.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{find_ref, mismatch, CaseResult, Ctx, Failure};

const CONSOLE_READY: &str = "Console fixture ready";
const NETWORK_READY: &str = "Network fixture ready";
/// How long a case polls for entries to reach the host.
const ENTRY_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);
/// Long enough for a scroll the page made to reach its listener.
const SCROLL_SETTLE: Duration = Duration::from_millis(500);

/// Read `verb` from the start until `done` holds for the entries, or the
/// wait runs out. Returns the last reply and its entries.
async fn read_until(
    c: &Ctx<'_>,
    verb: &str,
    done: impl Fn(&[Value]) -> bool,
) -> Result<(Value, Vec<Value>), Failure> {
    let until = Instant::now() + ENTRY_WAIT;
    loop {
        let reply = c.call(verb, json!({ "limit": 200 })).await?;
        let entries = reply["page"][verb].as_array().cloned().unwrap_or_default();
        if done(&entries) || Instant::now() > until {
            return Ok((reply, entries));
        }
        tokio::time::sleep(POLL).await;
    }
}

fn has(entries: &[Value], key: &str, value: &str, extra: impl Fn(&Value) -> bool) -> bool {
    entries
        .iter()
        .any(|e| e[key].as_str().is_some_and(|v| v.contains(value)) && extra(e))
}

async fn pages_past(c: &Ctx<'_>, verb: &str, reply: &Value) -> CaseResult {
    let cursor = reply["data"]["cursor"].clone();
    let next = c.call(verb, json!({ "cursor": cursor })).await?;
    match next["page"][verb].as_array() {
        Some(rest) if rest.is_empty() => Ok(()),
        other => Err(mismatch(format!("{verb} after the cursor returned {other:?}"))),
    }
}

pub async fn console(c: &Ctx<'_>) -> CaseResult {
    c.open("/console.html", CONSOLE_READY).await?;
    let want = [("log", "conformance log 1"), ("warn", "conformance warn"), ("error", "conformance error")];
    let (reply, entries) = read_until(c, "console", |entries| {
        want.iter().all(|(level, text)| has(entries, "text", text, |e| e["level"] == *level))
    })
    .await?;
    for (level, text) in want {
        if !has(&entries, "text", text, |e| e["level"] == level) {
            return Err(mismatch(format!("console lacks {level} `{text}`: {entries:?}")));
        }
    }
    match reply["data"]["fidelity"].as_str() {
        Some("trusted" | "synthetic") => {}
        other => return Err(mismatch(format!("console fidelity is {other:?}"))),
    }
    pages_past(c, "console", &reply).await
}

pub async fn network(c: &Ctx<'_>) -> CaseResult {
    c.open("/network.html", NETWORK_READY).await?;
    let ping = c.fixtures.url("/api/ping");
    let pixel = c.fixtures.url("/pixel.svg");
    let (reply, entries) = read_until(c, "network", |entries| {
        has(entries, "url", &ping, |e| e["status"] == 200) && has(entries, "url", &pixel, |_| true)
    })
    .await?;
    if !has(&entries, "url", &ping, |e| e["method"] == "GET" && e["status"] == 200) {
        return Err(mismatch(format!("network lacks GET {ping} 200: {entries:?}")));
    }
    if !has(&entries, "url", &pixel, |_| true) {
        return Err(mismatch(format!("network lacks the image {pixel}: {entries:?}")));
    }
    // Only an engine that sees each hop reports the redirect itself.
    let redirect = c.fixtures.url("/redirect-api");
    if reply["data"]["fidelity"] == "trusted" && !has(&entries, "url", &redirect, |e| e["status"] == 302) {
        return Err(mismatch(format!("network lacks the 302 hop {redirect}: {entries:?}")));
    }
    let text = reply.to_string();
    if text.contains("secret-") || entries.iter().any(|e| e["url"].as_str().is_some_and(|u| u.contains('?'))) {
        return Err(mismatch(format!("a network url kept its query string: {entries:?}")));
    }
    pages_past(c, "network", &reply).await
}

/// A `<pre>` longer than one text block: the snapshot shows its start with
/// its line breaks and says it cut text, and `read_text` pages give all of
/// it.
pub async fn long_text(c: &Ctx<'_>) -> CaseResult {
    c.open("/long-text.html", "Long text fixture").await?;
    let snap = c.call("snapshot", json!({})).await?;
    let outline = snap["page"]["snapshot"].as_str().unwrap_or_default();
    if !outline.contains(r#"- text "{\n"line 001": "abcdefghij"#) || outline.contains("line 100") {
        return Err(mismatch(format!("the snapshot does not hold the block's start: {outline}")));
    }
    if snap["page"]["truncated"] != true {
        return Err(mismatch("a cut text block left page.truncated false"));
    }
    let mut text = String::new();
    let mut cursor = 0;
    for _ in 0..10 {
        let page = c.call("read_text", json!({ "cursor": cursor, "limit": 2000 })).await?;
        text.push_str(page["page"]["text"].as_str().unwrap_or_default());
        cursor = page["data"]["cursor"].as_u64().unwrap_or_default();
        if page["data"]["more"] != true {
            break;
        }
    }
    let missing: Vec<String> = (1..=100)
        .map(|n| format!("\"line {n:03}\": \"abcdefghij"))
        .chain(["\"end\": true".to_string()])
        .filter(|line| !text.contains(line.as_str()))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(mismatch(format!("read_text pages lack {missing:?}")))
    }
}

/// Forty paragraphs, each longer than a text block, before a page's
/// navigation and comment form: the text gives way so every control keeps
/// its ref in the snapshot.
pub async fn long_article(c: &Ctx<'_>) -> CaseResult {
    c.open("/long-article.html", "Long article fixture").await?;
    let snap = c.call("snapshot", json!({})).await?;
    let outline = snap["page"]["snapshot"].as_str().unwrap_or_default();
    let controls = [("link", "Next page"), ("button", "Load more"), ("textbox", "Comment"), ("button", "Post comment")];
    let missing: Vec<_> = controls
        .iter()
        .filter(|(role, name)| find_ref(outline, role, name).is_none())
        .collect();
    if !missing.is_empty() {
        return Err(mismatch(format!("the snapshot lost the refs of {missing:?}: {outline}")));
    }
    if !outline.contains("Paragraph 01. the quick brown fox") || !outline.contains("Paragraph 40.") {
        return Err(mismatch(format!("the snapshot lost the article's paragraphs: {outline}")));
    }
    if snap["page"]["truncated"] != true {
        return Err(mismatch("shortened text left page.truncated false"));
    }
    Ok(())
}

/// Reading an element's text through its ref leaves the page where it was.
pub async fn read_text_in_place(c: &Ctx<'_>) -> CaseResult {
    c.open("/far-button.html", "Scrolled: no").await?;
    let far = c.ref_of("button", "Far away").await?;
    let page = c.call("read_text", json!({ "ref": far })).await?;
    if page["page"]["text"] != "Far away" {
        return Err(mismatch(format!("read_text read {}", page["page"]["text"])));
    }
    tokio::time::sleep(SCROLL_SETTLE).await;
    c.expect_text("Scrolled: no").await
}
