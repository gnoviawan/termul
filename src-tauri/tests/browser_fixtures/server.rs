//! Loopback HTTP server for the browser conformance pages.
//!
//! Pages are static files under `pages/`. The server binds an OS-chosen port
//! on 127.0.0.1 and never the dev server's port: a page served from the dev
//! origin would count as a local page for Tauri's command ACL and hide the
//! remote-origin behaviour the suite exists to cover.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

const MAX_REQUEST_HEAD: usize = 16 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

pub const REDIRECT_PATH: &str = "/redirect";
pub const REDIRECT_TARGET_PATH: &str = "/redirect-target.html";

enum Reply {
    Page(&'static str),
    Redirect(&'static str),
    NotFound,
}

fn route(path: &str) -> Reply {
    match path {
        "/" | "/index.html" => Reply::Page(include_str!("pages/index.html")),
        "/form.html" => Reply::Page(include_str!("pages/form.html")),
        "/form-done.html" => Reply::Page(include_str!("pages/form-done.html")),
        "/delayed.html" => Reply::Page(include_str!("pages/delayed.html")),
        REDIRECT_TARGET_PATH => Reply::Page(include_str!("pages/redirect-target.html")),
        REDIRECT_PATH => Reply::Redirect(REDIRECT_TARGET_PATH),
        _ => Reply::NotFound,
    }
}

pub struct FixtureServer {
    addr: SocketAddr,
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
        std::thread::Builder::new()
            .name("fixture-accept".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let _ = std::thread::Builder::new()
                        .name("fixture-conn".into())
                        .spawn(move || {
                            let _ = serve(stream);
                        });
                }
            })?;
        Ok(Self { addr })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.addr.port(), path)
    }
}

fn read_request_head(stream: &mut TcpStream) -> io::Result<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        if buf.len() > MAX_REQUEST_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn serve(mut stream: TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let head = read_request_head(&mut stream)?;
    let mut request_line = head.lines().next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let target = request_line.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");

    let (status, extra_headers, body): (&str, String, &str) = match route(path) {
        Reply::Page(html) => ("200 OK", "Content-Type: text/html; charset=utf-8\r\n".into(), html),
        Reply::Redirect(to) => ("302 Found", format!("Location: {to}\r\n"), ""),
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
