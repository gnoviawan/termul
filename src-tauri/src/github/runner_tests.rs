use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use super::error::GithubError;
use super::fake_gh::{fail, fake_gh, ok};
use super::runner::{exhausted_reset, GhCall, GhRunner, SpawnFailure};

fn call(host: &str) -> GhCall {
    GhCall::new(Some(host), ["api", "graphql"])
}

#[test]
fn missing_binary_and_timeout_map_to_contract_codes() {
    let (process, _) = fake_gh(|args| {
        if args[0] == "missing" {
            Err(SpawnFailure::Missing)
        } else {
            Err(SpawnFailure::TimedOut)
        }
    });
    let runner = GhRunner::new(process);
    assert_eq!(
        runner.stdout(&GhCall::new(None, ["missing"])).unwrap_err(),
        GithubError::CliMissing
    );
    assert_eq!(
        runner.stdout(&GhCall::new(None, ["slow"])).unwrap_err(),
        GithubError::Timeout
    );
}

#[test]
fn rate_limit_opens_a_backoff_window_until_the_reported_reset() {
    let reset = SystemTime::now() + Duration::from_secs(600);
    let reset_secs = reset
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let (process, log) = fake_gh(move |args| {
        if args[1] == "rate_limit" {
            ok(&format!(
                r#"{{"resources":{{"core":{{"limit":5000,"remaining":4000,"reset":1}},"graphql":{{"limit":5000,"remaining":0,"reset":{reset_secs}}}}}}}"#
            ))
        } else {
            fail("gh: API rate limit already exceeded for user ID 1. (HTTP 403)")
        }
    });
    let runner = GhRunner::new(process);
    let first = runner.stdout(&call("github.com")).unwrap_err();
    let second = runner.stdout(&call("github.com")).unwrap_err();
    let until = chrono::DateTime::<chrono::Utc>::from(
        SystemTime::UNIX_EPOCH + Duration::from_secs(reset_secs),
    )
    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    assert_eq!(
        first,
        GithubError::RateLimited {
            until: until.clone()
        }
    );
    assert_eq!(second, GithubError::RateLimited { until });
    assert_eq!(
        log.calls(),
        vec!["github.com api graphql", "github.com api rate_limit"],
        "the second call fails fast without spawning gh"
    );
    let other_host = runner.stdout(&call("ghe.corp")).unwrap_err();
    assert_eq!(other_host.code(), "GH_RATE_LIMITED");
    assert_eq!(
        log.count_containing("ghe.corp api graphql"),
        1,
        "backoff is per host"
    );
}

#[test]
fn secondary_limit_without_an_exhausted_resource_backs_off_a_minute() {
    let (process, _) = fake_gh(|args| {
        if args[1] == "rate_limit" {
            ok(r#"{"resources":{"core":{"remaining":10,"reset":1}}}"#)
        } else {
            fail("gh: You have exceeded a secondary rate limit. (HTTP 403)")
        }
    });
    let runner = GhRunner::new(process);
    let GithubError::RateLimited { until } = runner.stdout(&call("github.com")).unwrap_err() else {
        panic!("expected rate limit");
    };
    let until = chrono::DateTime::parse_from_rfc3339(&until).unwrap();
    let wait = until
        .signed_duration_since(chrono::Utc::now())
        .num_seconds();
    assert!((55..=60).contains(&wait), "backoff is ~60s, got {wait}s");
}

#[test]
fn exhausted_reset_picks_the_latest_exhausted_resource() {
    let stdout = br#"{"resources":{"core":{"remaining":0,"reset":100},"graphql":{"remaining":0,"reset":200},"search":{"remaining":5,"reset":900}}}"#;
    assert_eq!(
        exhausted_reset(stdout),
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(200))
    );
    assert_eq!(
        exhausted_reset(br#"{"resources":{"core":{"remaining":1,"reset":100}}}"#),
        None
    );
}

#[test]
fn at_most_four_gh_processes_run_at_once() {
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (process, _) = {
        let running = running.clone();
        let peak = peak.clone();
        fake_gh(move |_| {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
            running.fetch_sub(1, Ordering::SeqCst);
            ok("{}")
        })
    };
    let runner = Arc::new(GhRunner::new(process));
    let threads: Vec<_> = (0..10)
        .map(|_| {
            let runner = runner.clone();
            std::thread::spawn(move || runner.stdout(&call("github.com")).map(|_| ()))
        })
        .collect();
    for thread in threads {
        assert_eq!(thread.join().unwrap(), Ok(()));
    }
    assert_eq!(peak.load(Ordering::SeqCst), 4);
}
