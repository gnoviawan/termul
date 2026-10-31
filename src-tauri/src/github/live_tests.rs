//! Walks the real `gh` login against this checkout's `origin`. Read-only:
//! never merges. Run with
//! `cargo test --lib github::live_tests -- --ignored --nocapture`
//! (`TERMUL_GH_LIVE_CWD` overrides the checkout).

use std::time::Instant;

use super::service::GithubService;
use super::types::*;

fn list(service: &GithubService, cwd: &str, kind: GithubKindFilter) -> GithubListResult {
    service
        .list_items(&GithubListRequest {
            cwd: cwd.to_string(),
            filter: GithubListFilter {
                repo: GithubRepoSlot::Origin,
                kind,
                state: GithubStateFilter::Open,
                assigned_to_me: false,
                review_requested: false,
            },
            refresh: false,
        })
        .expect("list")
}

#[test]
#[ignore = "uses the machine's gh login and the network"]
fn live_gh_walkthrough() {
    let cwd = std::env::var("TERMUL_GH_LIVE_CWD")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/..").to_string());
    let cwd = std::fs::canonicalize(cwd)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let service = GithubService::shared();

    let context = service.context(&cwd).expect("context");
    println!("context: {}", serde_json::to_string(&context).unwrap());
    assert!(matches!(
        context.repo,
        GithubRepoResolution::Resolved { .. }
    ));

    let issues = list(&service, &cwd, GithubKindFilter::Issue);
    println!(
        "open issues on {}: {} (first 3)",
        issues.repo,
        issues.items.len()
    );
    for item in issues.items.iter().take(3) {
        println!(
            "  #{} [{:?}] {} by {} labels={:?}",
            item.number,
            item.state,
            item.title,
            item.author,
            item.labels.iter().map(|l| &l.name).collect::<Vec<_>>()
        );
    }

    let prs = list(&service, &cwd, GithubKindFilter::Pr);
    println!("open PRs: {} (first 5)", prs.items.len());
    for item in prs.items.iter().take(5) {
        println!(
            "  #{} [{:?}] checks={:?} {}",
            item.number, item.state, item.checks, item.title
        );
    }
    let started = Instant::now();
    list(&service, &cwd, GithubKindFilter::Pr);
    println!("second PR list (cache): {:?}", started.elapsed());

    let pr = prs
        .items
        .iter()
        .find(|item| item.checks == Some(GithubCheckRollup::Failure))
        .or(prs.items.first())
        .expect("an open PR");
    let detail = service
        .get_item(&GithubItemRequest {
            cwd: cwd.clone(),
            repo: GithubRepoSlot::Origin,
            kind: GithubItemKind::Pr,
            number: pr.number,
            refresh: false,
        })
        .expect("detail");
    let pull = detail.pr.as_ref().expect("pr detail");
    println!(
        "PR #{} head={} {} -> {} mergeable={:?} mergeState={} auto={} +{} -{} files={} comments={} threads={} (unresolved {})",
        detail.item.number,
        &pull.head_sha[..12.min(pull.head_sha.len())],
        pull.head_ref_name,
        pull.base_ref_name,
        pull.mergeable,
        pull.merge_state_status,
        pull.auto_merge_enabled,
        pull.additions,
        pull.deletions,
        pull.changed_files,
        detail.comments.len(),
        pull.review_threads.len(),
        pull.review_threads.iter().filter(|t| !t.is_resolved).count()
    );

    let checks = service
        .get_checks(&GithubChecksRequest {
            cwd: cwd.clone(),
            repo: GithubRepoSlot::Origin,
            number: pr.number,
            refresh: false,
        })
        .expect("checks");
    println!(
        "checks: head={} rollup={:?} total={}",
        &checks.head_sha[..12.min(checks.head_sha.len())],
        checks.rollup,
        checks.checks.len()
    );
    for check in checks
        .checks
        .iter()
        .filter(|c| c.status == GithubCheckStatus::Failure)
    {
        println!(
            "  FAILED {} / {:?} job={:?}",
            check.name, check.workflow, check.job_id
        );
    }
    if let Some(job_id) = checks
        .checks
        .iter()
        .filter(|c| c.status == GithubCheckStatus::Failure)
        .find_map(|c| c.job_id)
    {
        let log = service
            .get_check_log(&GithubCheckLogRequest {
                cwd: cwd.clone(),
                repo: GithubRepoSlot::Origin,
                job_id,
            })
            .expect("log");
        let lines: Vec<&str> = log.tail.lines().collect();
        println!(
            "log tail of job {job_id}: {} lines, {} bytes, truncated={}; last 8:",
            lines.len(),
            log.tail.len(),
            log.truncated
        );
        for line in &lines[lines.len().saturating_sub(8)..] {
            println!("  | {line}");
        }
    }
}
