//! Real survival e2e for the supervisor daemon (Unix).
//!
//! This launches the ACTUAL `termul-supervisor` binary as a separate detached
//! process, talks to it over the Unix socket, and proves the core promise:
//!
//!   client spawns a CLI via the daemon
//!     -> client disconnects (simulated Termul crash/force-close)
//!     -> the CLI process is STILL ALIVE (owned by the daemon, not the client)
//!     -> a new client reconnects, lists sessions, attaches
//!     -> scrollback replay returns the earlier output
//!     -> shutdown kill_all tears everything down
//!
//! Skipped automatically on non-unix.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn supervisor_bin() -> std::path::PathBuf {
    // Cargo sets CARGO_BIN_EXE_<name> for integration tests of bin targets.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_termul-supervisor"))
}

fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct Daemon {
    child: Child,
    socket: std::path::PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Launch the real daemon binary with a test-private socket path and wait until
/// the socket is connectable.
#[allow(clippy::zombie_processes)] // child is reaped in Daemon::drop
fn launch_daemon() -> Daemon {
    launch_daemon_with_token(None)
}

#[allow(clippy::zombie_processes)] // child is reaped in Daemon::drop
fn launch_daemon_with_token(token: Option<&str>) -> Daemon {
    // Each daemon gets its own XDG_RUNTIME_DIR so its socket name does not
    // collide with other concurrently-running test daemons.
    let xdg_dir = std::env::temp_dir().join(format!(
        "termul-sup-e2e-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    ));
    std::fs::create_dir_all(&xdg_dir).expect("create xdg dir");

    let mut cmd = Command::new(supervisor_bin());
    cmd.env("XDG_RUNTIME_DIR", &xdg_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(t) = token {
        cmd.env("TERMUL_SUPERVISOR_TOKEN", t);
    }
    let child = cmd.spawn().expect("launch termul-supervisor");

    // The daemon uses XDG_RUNTIME_DIR/termul-supervisor.sock.
    let actual_socket = xdg_dir.join("termul-supervisor.sock");

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if UnixStream::connect(&actual_socket).is_ok() {
            return Daemon {
                child,
                socket: actual_socket,
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("daemon socket never became connectable");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &std::path::Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect to daemon");
        let writer = stream.try_clone().expect("clone stream");
        Self {
            reader: BufReader::new(stream),
            writer,
        }
    }

    fn send(&mut self, json: &str) {
        self.writer.write_all(json.as_bytes()).unwrap();
        self.writer.write_all(b"\n").unwrap();
        self.writer.flush().unwrap();
    }

    fn recv(&mut self) -> serde_json::Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    /// Read frames until one whose "type" matches, returning it.
    fn recv_until(&mut self, ty: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let frame = self.recv();
            if frame["type"] == ty {
                return frame;
            }
        }
        panic!("never received frame of type {ty}");
    }
}

#[test]
fn cli_survives_client_disconnect_and_reattaches() {
    let daemon = launch_daemon();

    // --- Client A: handshake + spawn a long-lived CLI that emits a marker.
    let mut client_a = Client::connect(&daemon.socket);
    client_a.send(r#"{"type":"hello","protocol_version":1,"app_instance_id":"a","auth_token":""}"#);
    let ack = client_a.recv_until("hello_ack");
    assert_eq!(ack["protocol_version"], 1);

    // A shell that prints a unique marker then sleeps, so it stays alive across
    // the disconnect and the marker is in scrollback for replay.
    let marker = "SURVIVE-MARKER-42";
    let spawn = format!(
        r#"{{"type":"spawn","spec":{{"shell":"/bin/sh","cwd":"/tmp","cols":80,"rows":24,"command":"/bin/sh","args":["-c","printf '{marker}\\n'; sleep 60"],"env":[]}}}}"#
    );
    client_a.send(&spawn);
    let spawned = client_a.recv_until("spawned");
    let session_id = spawned["session_id"].as_str().unwrap().to_string();
    let pid = spawned["pid"].as_u64().unwrap() as u32;
    assert!(pid > 0);

    // Give the child a moment to print the marker.
    std::thread::sleep(Duration::from_millis(300));
    assert!(is_pid_alive(pid), "CLI must be alive right after spawn");

    // --- Simulate Termul crash: drop the client connection entirely.
    drop(client_a);
    std::thread::sleep(Duration::from_millis(300));

    // The CLI must STILL be alive — it is owned by the daemon, not the client.
    assert!(
        is_pid_alive(pid),
        "CLI must survive client disconnect (this is the whole point)"
    );

    // --- Client B reconnects, lists sessions, finds the survivor.
    let mut client_b = Client::connect(&daemon.socket);
    client_b.send(r#"{"type":"hello","protocol_version":1,"app_instance_id":"b","auth_token":""}"#);
    client_b.recv_until("hello_ack");
    client_b.send(r#"{"type":"list_sessions"}"#);
    let sessions = client_b.recv_until("sessions");
    let arr = sessions["sessions"].as_array().unwrap();
    assert!(
        arr.iter().any(|s| s["sessionId"] == session_id.as_str()
            && s["status"] == "running"),
        "reconnected client must see the surviving session as running: {arr:?}"
    );

    // --- Attach: scrollback replay must contain the marker printed before the
    // disconnect.
    client_b.send(&format!(
        r#"{{"type":"attach","session_id":"{session_id}"}}"#
    ));
    let scrollback = client_b.recv_until("scrollback");    let data = scrollback["data"].as_array().unwrap();
    let bytes: Vec<u8> = data.iter().map(|v| v.as_u64().unwrap() as u8).collect();
    let replayed = String::from_utf8_lossy(&bytes);
    assert!(
        replayed.contains(marker),
        "scrollback replay must contain pre-disconnect output, got: {replayed:?}"
    );

    // --- Shutdown kill_all reaps the child.
    client_b.send(r#"{"type":"shutdown","kill_all":true}"#);
    client_b.recv_until("ok");

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !is_pid_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!is_pid_alive(pid), "kill_all must terminate the CLI");
}

#[test]
fn daemon_rejects_wrong_auth_token() {
    let daemon = launch_daemon_with_token(Some("correct-horse-battery-staple"));

    // Wrong token: handshake must be rejected with an unauthorized error.
    let mut bad = Client::connect(&daemon.socket);
    bad.send(r#"{"type":"hello","protocol_version":1,"app_instance_id":"x","auth_token":"WRONG"}"#);
    let err = bad.recv_until("error");
    assert_eq!(err["code"], "unauthorized");
    drop(bad);

    // Correct token: handshake succeeds and the session is usable.
    let mut good = Client::connect(&daemon.socket);
    good.send(
        r#"{"type":"hello","protocol_version":1,"app_instance_id":"y","auth_token":"correct-horse-battery-staple"}"#,
    );
    let ack = good.recv_until("hello_ack");
    assert_eq!(ack["protocol_version"], 1);

    good.send(r#"{"type":"list_sessions"}"#);
    good.recv_until("sessions");

    good.send(r#"{"type":"shutdown","kill_all":true}"#);
    good.recv_until("ok");
}

#[test]
fn daemon_requires_hello_before_other_requests() {
    let daemon = launch_daemon_with_token(Some("tok-123"));

    // Sending a request before authenticating must be rejected.
    let mut client = Client::connect(&daemon.socket);
    client.send(r#"{"type":"list_sessions"}"#);
    let err = client.recv_until("error");
    assert_eq!(err["code"], "unauthorized");

    // Clean shutdown via an authenticated client so the daemon exits.
    let mut admin = Client::connect(&daemon.socket);
    admin.send(r#"{"type":"hello","protocol_version":1,"app_instance_id":"z","auth_token":"tok-123"}"#);
    admin.recv_until("hello_ack");
    admin.send(r#"{"type":"shutdown","kill_all":true}"#);
    admin.recv_until("ok");
}
