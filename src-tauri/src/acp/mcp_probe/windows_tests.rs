use super::*;
use crate::process_util::test_support::{
    grandchild_launcher_script, is_alive, powershell_args, read_pid_file, wait_for_exit,
    KillOnFail, EXIT_TIMEOUT,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_timeout_kills_the_server_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let pid_file = dir.path().join("pid");
    let config = McpServerConfig {
        r#type: Some("stdio".to_string()),
        name: "hung-launcher".to_string(),
        command: Some("powershell.exe".to_string()),
        args: powershell_args(&grandchild_launcher_script(&pid_file)),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
    };
    let probe_task = tokio::spawn(probe(config));
    let grandchild = tokio::task::spawn_blocking(move || read_pid_file(&pid_file))
        .await
        .expect("pid reader");
    let _cleanup = KillOnFail(grandchild);
    assert!(is_alive(grandchild), "grandchild runs during the probe");

    let result = probe_task.await.expect("probe task");

    assert_eq!(result.status, ProbeStatus::Disconnected);
    assert_eq!(
        result.error.as_deref(),
        Some(format!("probe timed out after {}s", PROBE_TIMEOUT.as_secs()).as_str())
    );
    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the probe timeout"
    );
}
