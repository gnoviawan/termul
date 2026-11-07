use super::*;

use std::cell::RefCell;
use std::io::ErrorKind;

// ---------------------------------------------------------------------------
// Collect + redaction
// ---------------------------------------------------------------------------

fn temp_log(label: &str, contents: &[u8]) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "termul-diagnostics-{label}-{}-{nanos}.log",
        std::process::id()
    ));
    std::fs::write(&path, contents).expect("write temp log");
    path
}

#[test]
fn tail_masks_secrets_and_home_paths() {
    let tail = concat!(
        "INFO plain line\n",
        "db password=hunter2 ok\n",
        "auth: Bearer abcdef0123456789\n",
        "token ghp_0123456789abcdefghij0123456789 done\n",
        "cd /home/tester/projects/x && ls $HOME ${HOME}/y %USERPROFILE%\\z\n",
    );
    let out = redact_log_tail(tail, Some("/home/tester"));

    assert!(out.contains("plain line"));
    assert!(out.contains("password=[redacted]"), "{out}");
    assert!(out.contains("Bearer [redacted]"), "{out}");
    assert!(out.contains("~/projects/x"), "{out}");
    assert!(out.contains("ls ~ ~/y ~\\z"), "{out}");
    for (index, secret) in [
        "hunter2",
        "abcdef0123456789",
        "ghp_0123456789abcdefghij0123456789",
        "/home/tester",
        "$HOME",
        "%USERPROFILE%",
    ]
    .iter()
    .enumerate()
    {
        // The marker value itself stays out of the message — a panic string
        // can land in captured logs, and CodeQL flags secrets written to
        // log sinks.
        assert!(
            !out.contains(secret),
            "redaction left marker #{index} in the output"
        );
    }
}

#[test]
fn home_scrub_respects_path_boundaries() {
    let out = scrub_home(
        "a /home/tester/x b /home/tester2/y c /home/tester.",
        Some("/home/tester"),
    );
    assert_eq!(out, "a ~/x b /home/tester2/y c /home/tester.");
}

#[test]
fn home_scrub_requires_a_boundary_before_the_match() {
    // The reported leak: a needle preceded by a path-component char is part
    // of a LONGER path, not the home dir — `/var/home/tester` must survive.
    let out = scrub_home(
        "see /var/home/tester/x and /home/tester/y or x/home/tester/z",
        Some("/home/tester"),
    );
    assert_eq!(out, "see /var/home/tester/x and ~/y or x/home/tester/z");
}

#[test]
fn replace_path_with_tilde_checks_both_sides() {
    assert_eq!(
        replace_path_with_tilde("a/home/u b /home/u c /home/u2 d home/u", "/home/u"),
        "a/home/u b ~ c /home/u2 d home/u"
    );
    assert_eq!(replace_path_with_tilde("x", ""), "x");
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn home_scrub_covers_case_variants_on_case_insensitive_filesystems() {
    // NTFS / standard APFS volumes resolve `C:\Users\Tester` and
    // `c:\users\tester` alike; the byte-exact pass alone leaks the username.
    let out = scrub_home(
        "a C:\\Users\\Tester\\x b c:\\users\\tester\\y C:/USERS/TESTER/z",
        Some("C:\\Users\\Tester"),
    );
    assert_eq!(out, "a ~\\x b ~\\y ~/z");
    // Case-variant needle still obeys both-sided boundaries.
    let out = scrub_home("/VAR/HOME/TESTER/x /home/tester/y", Some("/home/tester"));
    assert_eq!(out, "/VAR/HOME/TESTER/x ~/y");
    // Env-var aliases stay case-sensitive — shells are.
    let out = scrub_home("x $home ${home} y", Some("/home/tester"));
    assert_eq!(out, "x $home ${home} y");
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn replace_path_with_tilde_ci_matches_case_and_boundaries() {
    assert_eq!(
        replace_path_with_tilde_ci("in /HOME/TESTER/x and /home/tester2/y", "/home/tester"),
        "in ~/x and /home/tester2/y"
    );
    // A match preceded by a path-component char is left alone even
    // case-insensitively.
    assert_eq!(
        replace_path_with_tilde_ci("/VAR/HOME/TESTER/x", "/home/tester"),
        "/VAR/HOME/TESTER/x"
    );
}

#[test]
fn home_scrub_handles_windows_separators() {
    let out = scrub_home(
        "x C:\\Users\\tester\\docs y C:/Users/tester/docs",
        Some("C:\\Users\\tester"),
    );
    assert_eq!(out, "x ~\\docs y ~/docs");
}

#[test]
fn missing_log_file_reports_unavailable() {
    let ctx = collect_bug_report_context(Some(Path::new("/definitely/not/a/termul/log/file.log")));
    assert!(!ctx.log_available);
    assert!(ctx.log_tail.is_empty());
    assert!(!ctx.log_truncated);

    let ctx = collect_bug_report_context(None);
    assert!(!ctx.log_available);
    assert!(ctx.log_tail.is_empty());
}

#[test]
fn collect_smoke_has_version_run_id_and_timestamp() {
    let ctx = collect_bug_report_context(None);
    assert_eq!(ctx.app_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(ctx.run_id, crate::logging::run_id());
    assert_eq!(ctx.os, std::env::consts::OS);
    assert_eq!(ctx.arch, std::env::consts::ARCH);
    assert!(!ctx.collected_at.is_empty());
}

#[test]
fn small_log_is_available_untruncated_and_redacted() {
    let path = temp_log("small", b"hello world\nsecret token=abc123\n");
    let ctx = collect_bug_report_context(Some(&path));
    let _ = std::fs::remove_file(&path);

    assert!(ctx.log_available);
    assert!(!ctx.log_truncated);
    assert!(ctx.log_tail.contains("hello world"));
    assert!(
        ctx.log_tail.contains("token=[redacted]"),
        "{}",
        ctx.log_tail
    );
}

#[test]
fn oversized_log_tail_is_bounded_and_line_aligned() {
    // ~3 bytes over the 64 KiB window before a newline exists to align to.
    let mut contents = Vec::new();
    for i in 0..7000u32 {
        contents.extend_from_slice(format!("line-{i:05} padding-padding\n").as_bytes());
    }
    assert!(contents.len() > LOG_TAIL_BYTES);
    let path = temp_log("big", &contents);

    let ctx = collect_bug_report_context(Some(&path));
    let _ = std::fs::remove_file(&path);

    assert!(ctx.log_available);
    assert!(ctx.log_truncated);
    assert!(ctx.log_tail.len() <= LOG_TAIL_BYTES);
    // The tail opens with a whole line, not a mid-line fragment.
    assert!(ctx.log_tail.starts_with("line-"), "{}", &ctx.log_tail[..16]);
    // And ends with the newest line.
    assert!(ctx.log_tail.contains("line-06999"));
}

#[test]
fn single_giant_line_is_kept_within_bound() {
    let contents = vec![b'x'; LOG_TAIL_BYTES + 4096];
    let path = temp_log("giant", &contents);
    let ctx = collect_bug_report_context(Some(&path));
    let _ = std::fs::remove_file(&path);
    assert!(ctx.log_truncated);
    assert_eq!(ctx.log_tail.len(), LOG_TAIL_BYTES);
}

#[test]
fn oversized_log_ending_in_newline_keeps_the_window() {
    // A >64 KiB single line ending in '\n': the window's only newline is
    // its last byte, so line-aligning would return an EMPTY slice. The tail
    // falls back to the unaligned window.
    let mut contents = vec![b'x'; LOG_TAIL_BYTES + 10];
    contents.push(b'\n');
    let path = temp_log("eol", &contents);
    let ctx = collect_bug_report_context(Some(&path));
    let _ = std::fs::remove_file(&path);
    assert!(ctx.log_available);
    assert!(ctx.log_truncated);
    // 'x' * (LOG_TAIL_BYTES - 1) — `lines()` drops the trailing newline.
    assert_eq!(
        ctx.log_tail.len(),
        LOG_TAIL_BYTES - 1,
        "{}",
        ctx.log_tail.len()
    );
}

#[test]
fn tail_slice_falls_back_when_alignment_would_empty_the_window() {
    let mut window = vec![b'x'; 31];
    window.push(b'\n');
    assert_eq!(tail_slice(&window, true), &window[..]);
    // A real interior newline still aligns normally.
    let window = b"partial\nlast line\n";
    assert_eq!(tail_slice(window, true), &window[8..]);
    // Untruncated input is returned untouched.
    assert_eq!(tail_slice(window, false), &window[..]);
}

#[test]
fn read_tail_window_reads_only_the_bounded_span() {
    let mut contents = Vec::new();
    contents.extend_from_slice(b"HEAD-MARKER ");
    contents.extend(std::iter::repeat_n(b'y', LOG_TAIL_BYTES + 1024));
    contents.extend_from_slice(b" TAIL-MARKER");
    let path = temp_log("window", &contents);

    let (truncated, window) = read_tail_window(&path, LOG_TAIL_BYTES).expect("read window");
    let _ = std::fs::remove_file(&path);

    assert!(truncated);
    assert_eq!(window.len(), LOG_TAIL_BYTES);
    assert!(window.ends_with(b" TAIL-MARKER"));
    assert!(!window.starts_with(b"HEAD-MARKER"));

    // A file at/under the cap reads whole and is not truncated.
    let small = temp_log("window-small", b"all of it\n");
    let (truncated, window) = read_tail_window(&small, LOG_TAIL_BYTES).expect("read window");
    let _ = std::fs::remove_file(&small);
    assert!(!truncated);
    assert_eq!(window, b"all of it\n");
}

// ---------------------------------------------------------------------------
// gh submit (injectable runner seam)
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn exit_status(code: i32) -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code)
}

#[cfg(windows)]
fn exit_status(code: i32) -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code as u32)
}

fn output(code: i32, stdout: &str, stderr: &str) -> io::Result<Output> {
    Ok(Output {
        status: exit_status(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
    })
}

fn spawn_error() -> io::Result<Output> {
    Err(io::Error::new(ErrorKind::NotFound, "program not found"))
}

/// Records every `gh` invocation's args; `on_create` runs inside the
/// `issue create` call (when the staged body file still exists).
struct GhCalls {
    calls: RefCell<Vec<Vec<String>>>,
}

impl GhCalls {
    fn new() -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
        }
    }
    fn record(&self, args: &[&OsStr]) {
        self.calls.borrow_mut().push(
            args.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        );
    }
    fn nth(&self, n: usize) -> Vec<String> {
        self.calls.borrow()[n].clone()
    }
}

#[test]
fn gh_missing_is_unavailable() {
    let result = submit_with("t", "b", |_, _| spawn_error());
    assert!(
        matches!(result, BugReportSubmitResult::Unavailable { .. }),
        "{result:?}"
    );
}

#[test]
fn gh_version_failure_is_unavailable() {
    let result = submit_with("t", "b", |_, _| output(1, "", "weird"));
    assert!(matches!(result, BugReportSubmitResult::Unavailable { .. }));
}

#[test]
fn gh_not_authenticated_is_unavailable() {
    let result = submit_with("t", "b", |args, _| {
        if args[0] == OsStr::new("auth") {
            output(1, "", "not logged in")
        } else {
            output(0, "gh version 2.0", "")
        }
    });
    match result {
        BugReportSubmitResult::Unavailable { reason } => {
            assert!(reason.contains("authenticated"), "{reason}");
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[test]
fn gh_create_spawn_failure_is_unavailable() {
    let result = submit_with("t", "b", |args, _| {
        if args[0] == OsStr::new("issue") {
            spawn_error()
        } else {
            output(0, "ok", "")
        }
    });
    assert!(matches!(result, BugReportSubmitResult::Unavailable { .. }));
}

#[test]
fn gh_create_failure_is_failed_with_stderr() {
    let result = submit_with("t", "b", |args, _| {
        if args[0] == OsStr::new("issue") {
            output(1, "", "graphql: permission denied\nsecond line")
        } else {
            output(0, "ok", "")
        }
    });
    match result {
        BugReportSubmitResult::Failed { reason } => {
            assert!(reason.contains("graphql: permission denied"), "{reason}");
        }
        other => panic!("expected failed, got {other:?}"),
    }
}

#[test]
fn gh_success_returns_issue_url_and_cleans_up_body_file() {
    let calls = GhCalls::new();
    let staged = RefCell::new(PathBuf::new());
    let staged_body = RefCell::new(String::new());
    let result = submit_with("the title", "the body", |args, _| {
        calls.record(args);
        if args[0] == OsStr::new("issue") {
            let pos = args
                .iter()
                .position(|a| *a == OsStr::new("--body-file"))
                .expect("--body-file arg");
            let file = PathBuf::from(args[pos + 1]);
            *staged_body.borrow_mut() =
                std::fs::read_to_string(&file).expect("body file readable during create");
            *staged.borrow_mut() = file;
            return output(0, "https://github.com/gnoviawan/termul/issues/42\n", "");
        }
        output(0, "ok", "")
    });

    assert_eq!(
        result,
        BugReportSubmitResult::Submitted {
            issue_url: "https://github.com/gnoviawan/termul/issues/42".to_string()
        }
    );

    // Probe sequence: --version, auth status, issue create.
    assert_eq!(calls.nth(0), vec!["--version"]);
    assert_eq!(
        calls.nth(1),
        vec!["auth", "status", "--hostname", "github.com"]
    );
    let create = calls.nth(2);
    assert_eq!(create[..4], ["issue", "create", "-R", "gnoviawan/termul"]);
    assert!(
        create
            .windows(2)
            .any(|w| w[0] == "--title" && w[1] == "the title")
    );
    assert!(!create.iter().any(|a| a == "--label"));

    // Body reached the file and the file is gone after return.
    assert_eq!(*staged_body.borrow(), "the body");
    assert!(
        !staged.borrow().exists(),
        "staged body file must be removed"
    );
}

#[test]
fn gh_success_without_url_is_failed() {
    let result = submit_with("t", "b", |args, _| {
        if args[0] == OsStr::new("issue") {
            output(0, "Created issue draft", "")
        } else {
            output(0, "ok", "")
        }
    });
    assert!(matches!(result, BugReportSubmitResult::Failed { .. }));
}

#[test]
fn submit_failure_still_removes_body_file() {
    let staged = RefCell::new(PathBuf::new());
    let result = submit_with("t", "b", |args, _| {
        if args[0] == OsStr::new("issue") {
            let pos = args
                .iter()
                .position(|a| *a == OsStr::new("--body-file"))
                .unwrap();
            *staged.borrow_mut() = PathBuf::from(args[pos + 1]);
            return output(1, "", "boom");
        }
        output(0, "ok", "")
    });
    assert!(matches!(result, BugReportSubmitResult::Failed { .. }));
    assert!(!staged.borrow().exists());
}

#[test]
fn gh_timeout_maps_to_unavailable() {
    // `run_with_timeout` reports a hung `gh` as io TimedOut; every `Err`
    // arm in `submit_with` maps that to Unavailable (fallback path).
    let result = submit_with("t", "b", |_, _| {
        Err(io::Error::new(ErrorKind::TimedOut, "gh did not exit"))
    });
    assert!(
        matches!(result, BugReportSubmitResult::Unavailable { .. }),
        "{result:?}"
    );
}

#[cfg(unix)]
#[test]
fn run_with_timeout_kills_a_hung_child() {
    // `sh -c` execs a lone command, so killing the child kills the sleep.
    let start = Instant::now();
    let err = run_with_timeout(
        "sh",
        &[OsStr::new("-c"), OsStr::new("sleep 30")],
        Duration::from_millis(200),
    )
    .expect_err("a child that outlives the timeout must error");
    assert_eq!(err.kind(), ErrorKind::TimedOut, "{err}");
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "kill + wait must return promptly, not wait out the child"
    );
}

#[cfg(unix)]
#[test]
fn run_with_timeout_collects_output() {
    let out = run_with_timeout(
        "sh",
        &[
            OsStr::new("-c"),
            OsStr::new("echo out; echo err >&2; exit 3"),
        ],
        Duration::from_secs(10),
    )
    .expect("child should finish well inside the timeout");
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
    assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
}

#[cfg(unix)]
#[test]
fn staged_body_file_is_owner_only_and_cleaned_up() {
    use std::os::unix::fs::PermissionsExt;
    let file = write_body_file("report body").expect("write body file");
    let mode = std::fs::metadata(&file.0)
        .expect("stat staged file")
        .permissions()
        .mode()
        & 0o777;
    let path = file.0.clone();
    assert_eq!(mode, 0o600, "staged body must not be world/group-readable");
    drop(file);
    assert!(!path.exists(), "drop must remove the staged file");
}

#[test]
fn parse_issue_url_anchors_to_the_issue_repo_shape() {
    // A warning URL printed before the issue URL must not be captured.
    assert_eq!(
        parse_issue_url(
            "warning: see https://github.com/settings/tokens first\nhttps://github.com/gnoviawan/termul/issues/42\n"
        ),
        Some("https://github.com/gnoviawan/termul/issues/42".to_string())
    );
    // Non-issue URLs, other repos and non-numeric ids never match.
    assert_eq!(parse_issue_url("https://example.com/x"), None);
    assert_eq!(
        parse_issue_url("https://github.com/other/repo/issues/9"),
        None
    );
    assert_eq!(
        parse_issue_url("https://github.com/gnoviawan/termul/issues/abc"),
        None
    );
    assert_eq!(
        parse_issue_url("http://github.com/gnoviawan/termul/issues/4"),
        None
    );
    assert_eq!(parse_issue_url("Created issue draft"), None);
}

// ---------------------------------------------------------------------------
// Wire contract (mirrors src/shared/types/bug-report.types.ts)
// ---------------------------------------------------------------------------

#[test]
fn context_serializes_camel_case() {
    let ctx = BugReportContext {
        app_version: "1.0.0".to_string(),
        os: "linux".to_string(),
        arch: "x86_64".to_string(),
        channel: "release".to_string(),
        run_id: "abcd1234".to_string(),
        collected_at: "2026-10-19T00:00:00Z".to_string(),
        log_available: true,
        log_truncated: false,
        log_tail: "tail".to_string(),
    };
    let json = serde_json::to_value(&ctx).unwrap();
    for key in [
        "appVersion",
        "os",
        "arch",
        "channel",
        "runId",
        "collectedAt",
        "logAvailable",
        "logTruncated",
        "logTail",
    ] {
        assert!(json.get(key).is_some(), "missing {key}: {json}");
    }
    assert!(json.get("app_version").is_none());
    assert!(json.get("log_tail").is_none());
}

#[test]
fn submit_result_serializes_tagged_union() {
    let submitted = serde_json::to_value(BugReportSubmitResult::Submitted {
        issue_url: "u".to_string(),
    })
    .unwrap();
    assert_eq!(
        submitted,
        serde_json::json!({"kind": "submitted", "issueUrl": "u"})
    );
    let unavailable = serde_json::to_value(BugReportSubmitResult::Unavailable {
        reason: "r".to_string(),
    })
    .unwrap();
    assert_eq!(
        unavailable,
        serde_json::json!({"kind": "unavailable", "reason": "r"})
    );
    let failed = serde_json::to_value(BugReportSubmitResult::Failed {
        reason: "r".to_string(),
    })
    .unwrap();
    assert_eq!(failed, serde_json::json!({"kind": "failed", "reason": "r"}));
}
