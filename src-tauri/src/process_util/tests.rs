//! Windows tests for console hiding and [`KillOnCloseJob`].

use super::test_support::{
    grandchild_launcher_script, is_alive, powershell_args, read_pid_file, wait_for_exit,
    KillOnFail, EXIT_TIMEOUT,
};
use super::{hide_console, KillOnCloseJob};

/// Prints the child's console window handle (0 = no visible console).
const PRINT_CONSOLE_WINDOW: &str = "$t = Add-Type -Name W -Namespace P -PassThru \
    -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();'; \
    [Console]::Out.Write($t::GetConsoleWindow().ToInt64())";

fn console_probe_args() -> [&'static str; 4] {
    [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        PRINT_CONSOLE_WINDOW,
    ]
}

#[test]
fn hidden_std_command_has_no_console_window() {
    let mut command = std::process::Command::new("powershell");
    hide_console(&mut command).args(console_probe_args());
    let output = command.output().expect("spawn powershell");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
}

#[tokio::test]
async fn hidden_tokio_command_has_no_console_window() {
    let mut command = tokio::process::Command::new("powershell");
    hide_console(&mut command).args(console_probe_args());
    let output = command.output().await.expect("spawn powershell");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
}

#[test]
fn job_assignment_failure_degrades_to_none() {
    // An invalid process handle makes assignment fail; the caller keeps
    // running the process without tree-kill instead of erroring.
    assert!(KillOnCloseJob::new_assigned(std::ptr::null_mut(), "test", true).is_none());
}

fn launcher_in_job(pid_file: &std::path::Path) -> (std::process::Child, KillOnCloseJob, u32) {
    let mut command = std::process::Command::new("powershell.exe");
    hide_console(&mut command).args(powershell_args(&grandchild_launcher_script(pid_file)));
    let launcher = command.spawn().expect("spawn launcher");
    let job = KillOnCloseJob::new_assigned_pid(launcher.id(), "test", true).expect("job assigned");
    let grandchild = read_pid_file(pid_file);
    (launcher, job, grandchild)
}

#[test]
fn dropping_a_pid_assigned_job_kills_the_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (mut launcher, job, grandchild) = launcher_in_job(&dir.path().join("pid"));
    let _cleanup = KillOnFail(grandchild);
    let _launcher_cleanup = KillOnFail(launcher.id());
    assert!(
        is_alive(grandchild),
        "grandchild runs while the job is open"
    );

    drop(job);

    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the job close"
    );
    let _ = launcher.wait();
}

#[test]
fn closing_a_job_without_killing_leaves_the_tree_running() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (mut launcher, job, grandchild) = launcher_in_job(&dir.path().join("pid"));
    let _cleanup = KillOnFail(grandchild);
    let _launcher_cleanup = KillOnFail(launcher.id());

    job.close_without_killing();

    assert!(
        !wait_for_exit(grandchild, std::time::Duration::from_secs(1)),
        "grandchild {grandchild} was killed by close_without_killing"
    );
    assert!(
        launcher.try_wait().expect("poll launcher").is_none(),
        "launcher was killed by close_without_killing"
    );
}
