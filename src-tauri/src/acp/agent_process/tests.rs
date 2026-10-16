//! Windows tree-kill tests for [`TreeKillAgent`] and [`KillOnCloseJob`].
//!
//! The fake agent is a PowerShell launcher that starts a long-lived
//! `ping -n 60` grandchild (a stand-in for agy's self-spawned worker), prints
//! the grandchild PID to stderr, then either keeps running or exits.

use std::io::BufRead as _;
use std::os::windows::io::AsRawHandle as _;
use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
use agent_client_protocol::{Agent, Client, ConnectionTo, LineDirection};

use super::TreeKillAgent;
use crate::process_util::test_support::{is_alive, wait_for_exit, KillOnFail, EXIT_TIMEOUT};
use crate::process_util::{hide_console, KillOnCloseJob};

const PID_PREFIX: &str = "CHILD_PID=";
const PID_TIMEOUT: Duration = Duration::from_secs(30);

fn fake_agent_args(tail: &str) -> Vec<String> {
    fake_agent_args_after("", tail)
}

/// Like [`fake_agent_args`], but runs `gate` before starting the grandchild.
fn fake_agent_args_after(gate: &str, tail: &str) -> Vec<String> {
    let script = format!(
        "{gate}$p = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' \
         -WindowStyle Hidden -PassThru; \
         [Console]::Error.WriteLine('{PID_PREFIX}' + $p.Id); \
         [Console]::Error.Flush(); \
         {tail}"
    );
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        script,
    ]
}

fn fake_agent_server(tail: &str) -> McpServer {
    McpServer::Stdio(
        McpServerStdio::new("fake-agent", PathBuf::from("powershell.exe"))
            .args(fake_agent_args(tail)),
    )
}

fn parse_pid(line: &str) -> Option<u32> {
    line.trim().strip_prefix(PID_PREFIX)?.trim().parse().ok()
}

/// Fake agent wired to report the grandchild PID over a channel.
fn fake_agent(tail: &str) -> (TreeKillAgent, tokio::sync::mpsc::UnboundedReceiver<u32>) {
    let (pid_tx, pid_rx) = tokio::sync::mpsc::unbounded_channel();
    let agent = TreeKillAgent::new(fake_agent_server(tail)).with_debug(move |line, direction| {
        if direction == LineDirection::Stderr {
            if let Some(pid) = parse_pid(line) {
                let _ = pid_tx.send(pid);
            }
        }
    });
    (agent, pid_rx)
}

#[tokio::test]
async fn dropping_the_connection_kills_the_agent_grandchild() {
    let (agent, mut pid_rx) = fake_agent("Start-Sleep -Seconds 60");
    let connection = tokio::spawn(async move {
        Client
            .builder()
            .connect_with(agent, async move |_cx: ConnectionTo<Agent>| {
                futures::future::pending::<()>().await;
                Ok(())
            })
            .await
    });

    let grandchild = tokio::time::timeout(PID_TIMEOUT, pid_rx.recv())
        .await
        .expect("fake agent reported its grandchild in time")
        .expect("pid channel open");
    let _cleanup = KillOnFail(grandchild);
    assert!(
        is_alive(grandchild),
        "grandchild should run while connected"
    );

    // Dropping the connection future (kill/cancel path) must reap the tree.
    connection.abort();
    let _ = connection.await;

    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the dropped connection"
    );
}

#[tokio::test]
async fn launcher_exit_kills_the_grandchild_and_reports_stderr() {
    let (agent, mut pid_rx) = fake_agent("exit 3");
    let result = tokio::time::timeout(
        PID_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, async move |_cx: ConnectionTo<Agent>| {
                futures::future::pending::<()>().await;
                Ok(())
            }),
    )
    .await
    .expect("connection settles after the launcher exits");

    let grandchild = pid_rx
        .try_recv()
        .expect("fake agent reported its grandchild");
    let _cleanup = KillOnFail(grandchild);

    let error = format!("{:?}", result.expect_err("early non-zero exit is an error"));
    assert!(
        error.contains("Process exited with"),
        "unexpected error: {error}"
    );
    assert!(
        error.contains(PID_PREFIX),
        "stderr tail missing from: {error}"
    );
    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the launcher exit"
    );
}

#[tokio::test]
async fn protocol_shutdown_kills_a_launcher_that_ignores_stdin_eof() {
    // The `AcpManager::kill` path: the client's main closure returns `Ok(())`
    // and the protocol shuts down cleanly, but the launcher never exits on
    // stdin EOF. After the 1s grace the whole tree must be terminated.
    let (agent, mut pid_rx) = fake_agent("Start-Sleep -Seconds 60");
    let (grandchild_tx, grandchild_rx) = tokio::sync::oneshot::channel();
    let result = tokio::time::timeout(
        PID_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, async move |_cx: ConnectionTo<Agent>| {
                // Wait only until the worker exists, then shut down promptly.
                let pid = pid_rx
                    .recv()
                    .await
                    .expect("fake agent reported its grandchild");
                let _ = grandchild_tx.send(pid);
                Ok(())
            }),
    )
    .await
    .expect("connection settles after protocol shutdown");
    let grandchild = grandchild_rx.await.expect("grandchild pid forwarded");
    let _cleanup = KillOnFail(grandchild);

    assert!(
        result.is_ok(),
        "clean protocol shutdown is not an error: {result:?}"
    );
    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived protocol shutdown"
    );
}

#[test]
fn dropping_the_job_kills_the_whole_tree() {
    let mut command = std::process::Command::new("powershell.exe");
    hide_console(&mut command);
    let mut launcher = command
        // Gate the grandchild on a stdin line so it can only start after the
        // job is assigned below (no spawn-to-assign race in this test).
        .args(fake_agent_args_after(
            "[void][Console]::In.ReadLine(); ",
            "Start-Sleep -Seconds 60",
        ))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn fake agent");
    let launcher_pid = launcher.id();
    let _launcher_cleanup = KillOnFail(launcher_pid);
    let job =
        KillOnCloseJob::new_assigned(launcher.as_raw_handle(), "test", true).expect("job assigned");
    {
        use std::io::Write as _;
        let mut stdin = launcher.stdin.take().expect("stdin");
        writeln!(stdin).expect("release the fake agent gate");
    }

    let stderr = std::io::BufReader::new(launcher.stderr.take().expect("stderr"));
    let grandchild = stderr
        .lines()
        .map_while(Result::ok)
        .find_map(|line| parse_pid(&line))
        .expect("fake agent reported its grandchild");
    let _cleanup = KillOnFail(grandchild);
    assert!(
        is_alive(grandchild),
        "grandchild should run while the job is open"
    );

    drop(job);

    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the job close"
    );
    assert!(
        wait_for_exit(launcher_pid, EXIT_TIMEOUT),
        "launcher {launcher_pid} survived the job close"
    );
    let _ = launcher.wait();
}
