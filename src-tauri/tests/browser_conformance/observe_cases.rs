//! Cases for console and network observation. Each checks the entries a
//! fixture page produced, that a cursor pages past them, and that no URL
//! in a reply carries the query strings the page used.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{mismatch, CaseResult, Ctx, Failure};

const CONSOLE_READY: &str = "Console fixture ready";
const NETWORK_READY: &str = "Network fixture ready";
/// How long a case polls for entries to reach the host.
const ENTRY_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

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
