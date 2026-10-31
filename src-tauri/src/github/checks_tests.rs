use super::checks::{
    is_no_checks, job_id_of, log_tail, parse_checks, rollup, LOG_TAIL_BYTES, LOG_TAIL_LINES,
};
use super::types::{GithubCheck, GithubCheckRollup, GithubCheckStatus};

/// Rows of `gh pr checks 1579 --json name,state,bucket,link,workflow` (gh 2.98).
const CHECKS_JSON: &str = r#"[
{"bucket":"skipping","link":"https://github.com/gnoviawan/termul/actions/runs/41100700259/job/124222171366","name":"Verify Tauri Frontend Build","state":"SKIPPED","workflow":"PR Validation"},
{"bucket":"fail","link":"https://github.com/gnoviawan/termul/actions/runs/41100700259/job/124217788236","name":"Validate PR Description","state":"FAILURE","workflow":"PR Validation"},
{"bucket":"pass","link":"https://github.com/gnoviawan/termul/runs/124217588359","name":"CodeQL","state":"SUCCESS","workflow":""},
{"bucket":"skipping","link":"https://www.cubic.dev/pr/gnoviawan/termul/pull/1579","name":"cubic","state":"NEUTRAL","workflow":""},
{"bucket":"pending","link":"","name":"E2E","state":"IN_PROGRESS","workflow":"E2E"},
{"bucket":"cancel","link":"https://github.com/gnoviawan/termul/actions/runs/1/job/2","name":"Old","state":"CANCELLED","workflow":"CI"}
]"#;

fn check(status: GithubCheckStatus) -> GithubCheck {
    GithubCheck {
        name: "c".into(),
        workflow: None,
        status,
        details_url: None,
        job_id: None,
    }
}

#[test]
fn checks_map_buckets_links_and_job_ids() {
    let checks = parse_checks(CHECKS_JSON.as_bytes()).expect("parses");
    assert_eq!(
        checks[1],
        GithubCheck {
            name: "Validate PR Description".into(),
            workflow: Some("PR Validation".into()),
            status: GithubCheckStatus::Failure,
            details_url: Some(
                "https://github.com/gnoviawan/termul/actions/runs/41100700259/job/124217788236"
                    .into()
            ),
            job_id: Some(124217788236),
        }
    );
    assert_eq!(
        checks
            .iter()
            .map(|c| (c.status, c.job_id, c.workflow.is_some()))
            .collect::<Vec<_>>(),
        vec![
            (GithubCheckStatus::Skipped, Some(124222171366), true),
            (GithubCheckStatus::Failure, Some(124217788236), true),
            (GithubCheckStatus::Success, None, false),
            (GithubCheckStatus::Neutral, None, false),
            (GithubCheckStatus::Pending, None, true),
            (GithubCheckStatus::Cancelled, Some(2), true),
        ]
    );
    assert_eq!(checks[4].details_url, None);
}

#[test]
fn job_id_needs_an_actions_job_link() {
    assert_eq!(
        job_id_of("https://ghe.corp/o/r/actions/runs/7/job/99"),
        Some(99)
    );
    assert_eq!(job_id_of("https://github.com/o/r/runs/124217588359"), None);
}

#[test]
fn rollup_prefers_failure_then_pending() {
    use GithubCheckStatus::*;
    assert_eq!(rollup(&[]), None);
    assert_eq!(
        rollup(&[check(Success), check(Pending), check(Failure)]),
        Some(GithubCheckRollup::Failure)
    );
    assert_eq!(
        rollup(&[check(Success), check(Pending), check(Skipped)]),
        Some(GithubCheckRollup::Pending)
    );
    assert_eq!(
        rollup(&[check(Success), check(Neutral), check(Cancelled)]),
        Some(GithubCheckRollup::Success)
    );
}

#[test]
fn no_checks_message_is_recognised() {
    assert!(is_no_checks("no checks reported on the 'feat/x' branch\n"));
    assert!(!is_no_checks("HTTP 404"));
}

#[test]
fn log_tail_strips_escapes_and_keeps_the_last_200_lines() {
    let mut log = String::new();
    for i in 0..250 {
        log.push_str(&format!(
            "2026-10-30T17:42:09Z \x1b[36;1mline {i}\x1b[0m\r\n"
        ));
    }
    let (tail, truncated) = log_tail(log.as_bytes(), false);
    let lines: Vec<&str> = tail.lines().collect();
    assert_eq!(lines.len(), LOG_TAIL_LINES);
    assert_eq!(lines[0], "2026-10-30T17:42:09Z line 50");
    assert_eq!(lines[199], "2026-10-30T17:42:09Z line 249");
    assert!(truncated);
}

#[test]
fn log_tail_short_log_is_whole_and_untruncated() {
    let (tail, truncated) = log_tail(
        b"a\nb\n##[error]Process completed with exit code 1.\n",
        false,
    );
    assert_eq!(tail, "a\nb\n##[error]Process completed with exit code 1.");
    assert!(!truncated);
}

#[test]
fn log_tail_caps_bytes_on_a_line_boundary_and_drops_a_cut_first_line() {
    let long_line = "x".repeat(1000);
    let log = (0..40)
        .map(|i| format!("{i}:{long_line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (tail, truncated) = log_tail(log.as_bytes(), false);
    assert!(truncated);
    assert!(tail.len() <= 16 * 1024);
    assert!(
        tail.starts_with("24:"),
        "tail starts on a whole line: {}",
        &tail[..10]
    );
    assert!(tail.ends_with(&format!("39:{long_line}")));

    let (tail, truncated) = log_tail(b"agment of a line\nwhole line", true);
    assert_eq!((tail.as_str(), truncated), ("whole line", true));
}

/// A failed Actions job: setup, a test step that fails, then post-job
/// cleanup longer than the old 200-line tail.
fn failed_job_log(step_line: &str) -> String {
    let mut log = String::new();
    for i in 0..300 {
        log.push_str(&format!("2026-10-30T17:42:09.1Z step {i}{step_line}\r\n"));
    }
    log.push_str(
        "2026-10-30T17:42:10.1Z \x1b[31m##[error]Process completed with exit code 1.\x1b[0m\r\n",
    );
    for i in 0..250 {
        log.push_str(&format!("2026-10-30T17:42:11.1Z Post job cleanup {i}\r\n"));
    }
    log
}

#[test]
fn log_tail_centres_on_the_last_error_line() {
    let (tail, truncated) = log_tail(failed_job_log("").as_bytes(), false);
    let lines: Vec<&str> = tail.lines().collect();
    assert_eq!(lines.len(), 150 + 1 + 30);
    assert_eq!(lines[0], "2026-10-30T17:42:09.1Z step 150");
    assert_eq!(
        lines[150],
        "2026-10-30T17:42:10.1Z ##[error]Process completed with exit code 1."
    );
    assert_eq!(lines[180], "2026-10-30T17:42:11.1Z Post job cleanup 29");
    assert!(truncated);
}

#[test]
fn log_tail_byte_cap_drops_lines_before_the_error_first() {
    let padding = format!(" {}", "p".repeat(150));
    let (tail, truncated) = log_tail(failed_job_log(&padding).as_bytes(), false);
    let lines: Vec<&str> = tail.lines().collect();
    assert!(tail.len() <= LOG_TAIL_BYTES, "{}", tail.len());
    assert!(lines[0].starts_with("2026-10-30T17:42:09.1Z step "));
    assert!(lines.contains(&"2026-10-30T17:42:10.1Z ##[error]Process completed with exit code 1."));
    assert_eq!(
        lines.last().unwrap(),
        &"2026-10-30T17:42:11.1Z Post job cleanup 29",
        "the lines after the error are kept whole"
    );
    assert!(truncated);
}
