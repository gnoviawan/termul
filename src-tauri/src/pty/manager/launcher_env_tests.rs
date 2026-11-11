//! A terminal started by an app that the installer launcher preloaded must not
//! inherit the launcher's `LD_PRELOAD` entry, and must keep the user's own.
//!
//! The terminal env comes from the real process env, so the probe runs in a
//! child copy of this test binary that starts with the launcher's env.

use super::lifetime_tests::{wait_for_exit, wait_for_output_published};
use super::*;

const PROBE_FLAG: &str = "TERMUL_TEST_LAUNCHER_ENV_PROBE";
const USER_PRELOAD: &str = "libm.so.6";
const LAUNCHER_ENTRY: &str = "libpthread.so.0";

fn terminal_env_under_launcher(ld_preload: &str) -> String {
    let module = module_path!().split_once("::").expect("crate prefix").1;
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args([
            &format!("{module}::terminal_env_probe"),
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env(PROBE_FLAG, "1")
        .env("LD_PRELOAD", ld_preload)
        .env("TERMUL_LAUNCHER_PRELOAD", LAUNCHER_ENTRY)
        .output()
        .expect("run the probe");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(
        output.status.success(),
        "probe failed: {stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("terminal env: "))
        .unwrap_or_else(|| panic!("the probe printed no terminal env: {stdout}"))
        .to_string()
}

#[test]
fn a_terminal_keeps_the_users_preload_without_the_launchers_entry() {
    let seen = terminal_env_under_launcher(&format!("{USER_PRELOAD}:{LAUNCHER_ENTRY}"));

    assert_eq!(seen, "LD_PRELOAD=<libm.so.6> marker=<unset>");
}

#[test]
fn a_terminal_has_no_ld_preload_when_only_the_launcher_set_one() {
    let seen = terminal_env_under_launcher(LAUNCHER_ENTRY);

    assert_eq!(seen, "LD_PRELOAD=<unset> marker=<unset>");
}

#[tokio::test]
#[ignore = "runs in a child process started by the tests above"]
async fn terminal_env_probe() {
    if std::env::var_os(PROBE_FLAG).is_none() {
        return;
    }
    let manager = crate::web::test_pty_manager();
    let spawned = manager
        .spawn(
            SpawnOptions {
                project_id: Some("launcher-env".to_string()),
                program: Some("sh".to_string()),
                args: Some(vec![
                    "-c".to_string(),
                    r#"printf 'terminal env: LD_PRELOAD=<%s> marker=<%s>\n' "${LD_PRELOAD-unset}" "${TERMUL_LAUNCHER_PRELOAD-unset}""#
                        .to_string(),
                ]),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("spawn");
    let instance = manager.get(&spawned.info.id).expect("tracked");
    wait_for_exit(&instance).await;
    wait_for_output_published(&instance).await;

    let replay = instance.subscribe_from(0, None);
    let output: Vec<u8> = replay.chunks.iter().flat_map(|c| c.data.clone()).collect();
    println!("{}", String::from_utf8_lossy(&output));
}
