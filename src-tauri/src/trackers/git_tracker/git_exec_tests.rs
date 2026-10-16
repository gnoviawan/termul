use super::git_exec::{
    drain_capped, empty_tree_for, run_git_capture, GitRunError, StdoutCap, EMPTY_TREE,
};
use super::GitTracker;
// ---- stdout cap while draining ----

#[test]
fn drain_capped_keeps_first_n_nul_paths_and_drains_the_rest() {
    let data: Vec<u8> = b"a\0b\0c\0d\0e\0".to_vec();
    let kept = drain_capped(
        Some(std::io::Cursor::new(data.clone())),
        StdoutCap::NulPaths(3),
    )
    .join()
    .unwrap();
    assert_eq!(kept, b"a\0b\0c\0");
    let all = drain_capped(
        Some(std::io::Cursor::new(data.clone())),
        StdoutCap::Unbounded,
    )
    .join()
    .unwrap();
    assert_eq!(all, data);
}

#[test]
fn drain_capped_reads_past_the_cap_across_chunk_boundaries() {
    // More than one read chunk of paths, so the cap lands mid-stream and the
    // reader must still reach EOF.
    let mut data = Vec::new();
    for i in 0..5000 {
        data.extend_from_slice(format!("dir/file-{i}.txt\0").as_bytes());
    }
    let kept = drain_capped(Some(std::io::Cursor::new(data)), StdoutCap::NulPaths(1000))
        .join()
        .unwrap();
    assert_eq!(kept.iter().filter(|b| **b == 0).count(), 1000);
}

#[test]
fn drain_capped_bytes_keeps_the_first_n_bytes_across_chunks() {
    let data: Vec<u8> = (0..30_000u32).map(|i| (i % 251) as u8).collect();
    let kept = drain_capped(
        Some(std::io::Cursor::new(data.clone())),
        StdoutCap::Bytes(20_000),
    )
    .join()
    .unwrap();
    assert_eq!(kept, data[..20_000]);
    let short = drain_capped(
        Some(std::io::Cursor::new(data.clone())),
        StdoutCap::Bytes(40_000),
    )
    .join()
    .unwrap();
    assert_eq!(short, data);
    let none = drain_capped(Some(std::io::Cursor::new(data)), StdoutCap::Bytes(0))
        .join()
        .unwrap();
    assert!(none.is_empty());
}

#[test]
fn empty_tree_matches_the_object_format() {
    assert_eq!(empty_tree_for(40), EMPTY_TREE);
    assert_eq!(empty_tree_for(64).len(), 64);
}

#[test]
fn git_run_error_display_is_stable() {
    let failed = GitRunError::GitFailed {
        command: "diff",
        detail: "boom".to_string(),
    };
    assert_eq!(failed.to_string(), "git diff failed: boom");
    let silent = GitRunError::GitFailed {
        command: "diff",
        detail: String::new(),
    };
    assert_eq!(silent.to_string(), "git diff failed");
    assert_eq!(
        GitRunError::GitUnavailable("x".to_string()).to_string(),
        "Failed to run git: x"
    );
}

#[test]
fn it_git_runners_read_output_larger_than_the_pipe_buffer() {
    let tmp = std::env::temp_dir().join(format!("termul-gitexec-big-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("create temp dir");
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(tmp.clone());
    let cwd = tmp.to_str().unwrap();
    if run_git_capture(cwd, StdoutCap::Unbounded, &["init", "-q"], 10_000).is_err() {
        return;
    }
    let file = tmp.join("big.txt");
    std::fs::write(&file, "x".repeat(300_000)).expect("write file");
    let blob = run_git_capture(
        cwd,
        StdoutCap::Unbounded,
        &["hash-object", "-w", "big.txt"],
        10_000,
    )
    .expect("hash-object");
    let id = String::from_utf8_lossy(&blob.stdout).trim().to_string();

    // 300 KB is far past the ~64 KB pipe buffer; an undrained pipe would stall
    // until the timeout and fail here.
    let out = run_git_capture(cwd, StdoutCap::Unbounded, &["cat-file", "-p", &id], 10_000)
        .expect("cat-file");
    assert!(out.status.success());
    assert_eq!(out.stdout.len(), 300_000);
    let polled = GitTracker::run_git_command_with_timeout(cwd, &["cat-file", "-p", &id], 10_000)
        .expect("run_git_command must not stall on a full pipe");
    assert!(polled.status.success());
    assert_eq!(polled.stdout.len(), 300_000);

    let capped = run_git_capture(
        cwd,
        StdoutCap::Bytes(1000),
        &["cat-file", "-p", &id],
        10_000,
    )
    .expect("capped cat-file");
    assert!(capped.status.success(), "the rest is drained, not killed");
    assert_eq!(capped.stdout.len(), 1000);
}

#[cfg(windows)]
#[test]
fn timeout_kills_the_process_the_git_launcher_started() {
    use crate::process_util::test_support::{
        grandchild_launcher_script, is_alive, powershell_args, read_pid_file, wait_for_exit,
        KillOnFail, EXIT_TIMEOUT,
    };

    let dir = tempfile::tempdir().expect("temp dir");
    let pid_file = dir.path().join("grandchild.pid");
    let mut command = super::resolve::backend_command("powershell.exe");
    command.args(powershell_args(&grandchild_launcher_script(&pid_file)));
    let waiter = {
        let cwd = dir.path().to_string_lossy().into_owned();
        std::thread::spawn(move || {
            GitTracker::spawn_and_wait(command, &["status"], &cwd, 5_000).is_none()
        })
    };
    let grandchild = read_pid_file(&pid_file);
    let _cleanup = KillOnFail(grandchild);
    assert!(is_alive(grandchild), "grandchild runs until the timeout");

    assert!(waiter.join().unwrap(), "the launcher outlived the timeout");
    assert!(
        wait_for_exit(grandchild, EXIT_TIMEOUT),
        "grandchild {grandchild} survived the git timeout"
    );
}
