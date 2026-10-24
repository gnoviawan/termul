//! Loopback HTTP server for the browser conformance pages.
//!
//! Pages are static files under `pages/`. The server binds an OS-chosen port
//! on 127.0.0.1 and never the dev server's port: a page served from the dev
//! origin would count as a local page for Tauri's command ACL and hide the
//! remote-origin behaviour the suite exists to cover.
//!
//! Pages report what they observed by posting JSON to [`REPORT_PATH`].
//! The runner reads those reports back without evaluating script in the
//! page, so input cases work on engines whose eval channel does not.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_REQUEST_HEAD: usize = 16 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REPORT: usize = 64 * 1024;

pub const REDIRECT_PATH: &str = "/redirect";
pub const REDIRECT_TARGET_PATH: &str = "/redirect-target.html";
pub const REPORT_PATH: &str = "/report";
/// Where `labelled-form.html` posts. The urlencoded body is kept as a
/// `{"formPost": body}` report and the reply is the form-done page.
pub const FORM_POST_PATH: &str = "/labelled-submit";
pub const DOWNLOAD_PATH: &str = "/fixture-download.bin";
/// The fake file `DOWNLOAD_PATH` serves as an attachment.
pub const DOWNLOAD_BODY: &str = "fake download for the conformance suite\n";
/// An attachment of `BIG_DOWNLOAD_BYTES` zeros. `?length=announced` sends
/// its Content-Length up front and trickles the body; otherwise the body
/// streams at about 100 MB/s with no length, slow enough that a cancel at
/// the cap lands well before the end. Each reports how many bytes it sent
/// before it ended.
pub const BIG_DOWNLOAD_PATH: &str = "/fixture-big.bin";
/// Past the host's per-download cap.
pub const BIG_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;
const BIG_CHUNK: usize = 64 * 1024;
/// The announced body's pace: 64 KiB every 5 ms, so a whole body takes
/// longer than any case waits.
const TRICKLE: Duration = Duration::from_millis(5);
/// The streamed body's pace: 1 MiB every 10 ms.
const STREAM_STEP: u64 = 1024 * 1024;
const STREAM_PAUSE: Duration = Duration::from_millis(10);

/// A policy under which the browser runs no page script at all.
const STRICT_CSP: &str = "default-src 'none'; form-action 'self'";
const PIXEL_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;

enum Reply {
    Page(&'static str),
    /// A body of the given content type.
    Typed(&'static str, &'static str),
    StrictPage(&'static str),
    Redirect(&'static str),
    Attachment(&'static str),
    NotFound,
}

fn route(path: &str) -> Reply {
    match path {
        "/" | "/index.html" => Reply::Page(include_str!("pages/index.html")),
        "/form.html" => Reply::Page(include_str!("pages/form.html")),
        "/form-done.html" => Reply::Page(include_str!("pages/form-done.html")),
        "/labelled-form.html" => Reply::Page(include_str!("pages/labelled-form.html")),
        "/delayed.html" => Reply::Page(include_str!("pages/delayed.html")),
        "/tamper.html" => Reply::Page(include_str!("pages/tamper.html")),
        "/chat.html" => Reply::Page(include_str!("pages/chat.html")),
        "/input.html" => Reply::Page(include_str!("pages/input.html")),
        "/input-frame.html" => Reply::Page(include_str!("pages/input-frame.html")),
        "/actionability.html" => Reply::Page(include_str!("pages/actionability.html")),
        "/dialogs.html" => Reply::Page(include_str!("pages/dialogs.html")),
        "/popup.html" => Reply::Page(include_str!("pages/popup.html")),
        "/popup-target.html" => Reply::Page(include_str!("pages/popup-target.html")),
        "/external.html" => Reply::Page(include_str!("pages/external.html")),
        "/permissions.html" => Reply::Page(include_str!("pages/permissions.html")),
        "/controls.html" => Reply::Page(include_str!("pages/controls.html")),
        "/drag.html" => Reply::Page(include_str!("pages/drag.html")),
        "/dynamic.html" => Reply::Page(include_str!("pages/dynamic.html")),
        "/console.html" => Reply::Page(include_str!("pages/console.html")),
        "/network.html" => Reply::Page(include_str!("pages/network.html")),
        "/frames-same.html" => Reply::Page(include_str!("pages/frames-same.html")),
        "/frames-cross.html" => Reply::Page(include_str!("pages/frames-cross.html")),
        "/frame-inner.html" => Reply::Page(include_str!("pages/frame-inner.html")),
        "/frames-data.html" => Reply::Page(include_str!("pages/frames-data.html")),
        "/shadow.html" => Reply::Page(include_str!("pages/shadow.html")),
        "/csp.html" => Reply::StrictPage(include_str!("pages/csp.html")),
        "/api/ping" => Reply::Typed("application/json", r#"{"ok":true}"#),
        "/pixel.svg" => Reply::Typed("image/svg+xml", PIXEL_SVG),
        "/redirect-api" => Reply::Redirect("/api/ping?from=redirect"),
        "/password.html" => Reply::Page(include_str!("pages/password.html")),
        "/password-shadow.html" => Reply::Page(include_str!("pages/password-shadow.html")),
        "/password-switch.html" => Reply::Page(include_str!("pages/password-switch.html")),
        "/login-formless.html" => Reply::Page(include_str!("pages/login-formless.html")),
        "/checkout-outside-form.html" => Reply::Page(include_str!("pages/checkout-outside-form.html")),
        "/checkout-split-forms.html" => Reply::Page(include_str!("pages/checkout-split-forms.html")),
        "/rows.html" => Reply::Page(include_str!("pages/rows.html")),
        "/link-away.html" => Reply::Page(include_str!("pages/link-away.html")),
        "/upload.html" => Reply::Page(include_str!("pages/upload.html")),
        "/download.html" => Reply::Page(include_str!("pages/download.html")),
        "/download-big.html" => Reply::Page(include_str!("pages/download-big.html")),
        DOWNLOAD_PATH => Reply::Attachment(DOWNLOAD_BODY),
        REDIRECT_TARGET_PATH => Reply::Page(include_str!("pages/redirect-target.html")),
        REDIRECT_PATH => Reply::Redirect(REDIRECT_TARGET_PATH),
        _ => Reply::NotFound,
    }
}

type Reports = Arc<Mutex<Vec<String>>>;

pub struct FixtureServer {
    addr: SocketAddr,
    reports: Reports,
}

impl FixtureServer {
    /// Bind a free loopback port that is not in `avoid` and serve in the
    /// background for the life of the process.
    pub fn start(avoid: &[u16]) -> io::Result<Self> {
        let listener = loop {
            let candidate = TcpListener::bind(("127.0.0.1", 0))?;
            if !avoid.contains(&candidate.local_addr()?.port()) {
                break candidate;
            }
        };
        let addr = listener.local_addr()?;
        let reports = Reports::default();
        let sink = reports.clone();
        std::thread::Builder::new()
            .name("fixture-accept".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let sink = sink.clone();
                    let _ = std::thread::Builder::new()
                        .name("fixture-conn".into())
                        .spawn(move || {
                            let _ = serve(stream, &sink);
                        });
                }
            })?;
        Ok(Self { addr, reports })
    }

    /// Every report posted so far, in arrival order, parsed as JSON.
    pub fn reports(&self) -> Vec<serde_json::Value> {
        let raw = self.reports.lock().map(|r| r.clone()).unwrap_or_default();
        raw.iter()
            .filter_map(|body| serde_json::from_str(body).ok())
            .collect()
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.addr.port(), path)
    }
}

/// The request head, and whatever body bytes arrived with it.
fn read_request_head(stream: &mut TcpStream) -> io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        if buf.len() > MAX_REQUEST_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let split = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(buf.len(), |i| i + 4);
    let rest = buf.split_off(split);
    Ok((String::from_utf8_lossy(&buf).into_owned(), rest))
}

fn read_body(stream: &mut TcpStream, head: &str, mut body: Vec<u8>) -> io::Result<Vec<u8>> {
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
        .min(MAX_REPORT);
    let mut chunk = [0u8; 1024];
    while body.len() < length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(body)
}

fn serve(mut stream: TcpStream, reports: &Reports) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let (head, rest) = read_request_head(&mut stream)?;
    let mut request_line = head.lines().next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let target = request_line.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");

    if method == "POST" && path == REPORT_PATH {
        let body = read_body(&mut stream, &head, rest)?;
        if let Ok(mut all) = reports.lock() {
            all.push(String::from_utf8_lossy(&body).into_owned());
        }
        stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return stream.flush();
    }

    let path = if method == "POST" && path == FORM_POST_PATH {
        let body = read_body(&mut stream, &head, rest)?;
        let report = serde_json::json!({ "formPost": String::from_utf8_lossy(&body) });
        if let Ok(mut all) = reports.lock() {
            all.push(report.to_string());
        }
        "/form-done.html"
    } else {
        path
    };

    if path == BIG_DOWNLOAD_PATH {
        let announced = target.contains("length=announced");
        let sent = stream_big(&mut stream, announced);
        let report = serde_json::json!({
            "bigDownload": if announced { "announced" } else { "streamed" },
            "sent": sent,
            "complete": sent == BIG_DOWNLOAD_BYTES,
        });
        if let Ok(mut all) = reports.lock() {
            all.push(report.to_string());
        }
        return Ok(());
    }

    let (status, extra_headers, body): (&str, String, &str) = match route(path) {
        Reply::Page(html) => (
            "200 OK",
            "Content-Type: text/html; charset=utf-8\r\n".into(),
            html,
        ),
        Reply::Typed(kind, body) => ("200 OK", format!("Content-Type: {kind}\r\n"), body),
        Reply::StrictPage(html) => (
            "200 OK",
            format!("Content-Type: text/html; charset=utf-8\r\nContent-Security-Policy: {STRICT_CSP}\r\n"),
            html,
        ),
        Reply::Redirect(to) => ("302 Found", format!("Location: {to}\r\n"), ""),
        Reply::Attachment(body) => (
            "200 OK",
            "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"fixture-download.bin\"\r\n".into(),
            body,
        ),
        Reply::NotFound => (
            "404 Not Found",
            "Content-Type: text/plain; charset=utf-8\r\n".into(),
            "not found",
        ),
    };
    let body = if method == "HEAD" { "" } else { body };
    let response = format!(
        "HTTP/1.1 {status}\r\n{extra_headers}Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

/// Serve the big attachment and return how many body bytes went out
/// before the body ended or the client hung up.
fn stream_big(stream: &mut TcpStream, announced: bool) -> u64 {
    let length = if announced {
        format!("Content-Length: {BIG_DOWNLOAD_BYTES}\r\n")
    } else {
        String::new()
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"fixture-big.bin\"\r\n{length}Cache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return 0;
    }
    let chunk = [0u8; BIG_CHUNK];
    let mut sent = 0u64;
    while sent < BIG_DOWNLOAD_BYTES {
        let n = (BIG_DOWNLOAD_BYTES - sent).min(BIG_CHUNK as u64) as usize;
        if stream.write_all(&chunk[..n]).is_err() {
            break;
        }
        sent += n as u64;
        if announced {
            std::thread::sleep(TRICKLE);
        } else if sent.is_multiple_of(STREAM_STEP) {
            std::thread::sleep(STREAM_PAUSE);
        }
    }
    let _ = stream.flush();
    sent
}
