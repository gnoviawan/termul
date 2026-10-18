//! Behaviour of the conformance fixture server, checked over a real socket.

#[path = "browser_fixtures/server.rs"]
mod server;

use std::io::{Read, Write};
use std::net::TcpStream;

use server::{FixtureServer, REDIRECT_PATH, REDIRECT_TARGET_PATH};

fn get(server: &FixtureServer, path: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head.to_string(), body.to_string())
}

fn dev_url_port() -> u16 {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let dev_url = conf["build"]["devUrl"].as_str().unwrap();
    dev_url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.rsplit(':').next())
        .and_then(|port| port.parse().ok())
        .unwrap()
}

#[test]
fn serves_the_form_page() {
    let server = FixtureServer::start(&[]).unwrap();
    let (status, head, body) = get(&server, "/form.html");
    assert_eq!(status, 200);
    assert!(head.contains("Content-Type: text/html; charset=utf-8"));
    assert!(body.contains("<title>Conformance form</title>"));
}

#[test]
fn redirect_points_at_the_target_page() {
    let server = FixtureServer::start(&[]).unwrap();
    let (status, head, _) = get(&server, REDIRECT_PATH);
    assert_eq!(status, 302);
    assert!(head.contains(&format!("Location: {REDIRECT_TARGET_PATH}")));
    let (status, _, body) = get(&server, REDIRECT_TARGET_PATH);
    assert_eq!(status, 200);
    assert!(body.contains("Redirect target reached"));
}

#[test]
fn unknown_paths_are_404_and_query_strings_are_ignored() {
    let server = FixtureServer::start(&[]).unwrap();
    assert_eq!(get(&server, "/missing").0, 404);
    assert_eq!(get(&server, "/form.html?x=1").0, 200);
}

#[test]
fn never_binds_the_dev_server_port() {
    let dev_port = dev_url_port();
    assert_eq!(dev_port, 5180);
    for _ in 0..20 {
        let server = FixtureServer::start(&[dev_port]).unwrap();
        assert_ne!(server.port(), dev_port);
    }
}

#[test]
fn urls_point_at_the_bound_loopback_port() {
    let server = FixtureServer::start(&[]).unwrap();
    assert_eq!(
        server.url("/form.html"),
        format!("http://127.0.0.1:{}/form.html", server.port())
    );
}
