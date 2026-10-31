use super::fake_gh::{fail, fake_gh, has, ok, CallLog, Reply};
use super::runner::SpawnFailure;
use super::service::GithubService;
use super::types::*;
use crate::trackers::GitTracker;

const AUTH: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octo","tokenSource":"keyring","scopes":"repo, read:org"}]}}"#;
const FORK_PARENT: &str = r#"{"parent":{"name":"termul","owner":{"login":"gnoviawan"}}}"#;

fn search_data(remaining: u64) -> String {
    format!(
        r#"{{"data":{{"rateLimit":{{"limit":5000,"remaining":{remaining},"resetAt":"2999-01-01T00:00:00Z"}},"search":{{"nodes":[
{{"__typename":"Issue","number":3,"title":"t","state":"OPEN","url":"u","updatedAt":"x","author":{{"login":"a"}},"labels":{{"nodes":[]}},"assignees":{{"nodes":[]}},"comments":{{"totalCount":2}}}}]}}}}}}"#
    )
}

fn merge_state(status: &str) -> String {
    format!(
        r#"{{"data":{{"rateLimit":{{"limit":5000,"remaining":4900,"resetAt":"2999-01-01T00:00:00Z"}},"repository":{{"pullRequest":{{"state":"OPEN","headRefOid":"abc123","mergeStateStatus":"{status}"}}}}}}}}"#
    )
}

fn query_has(args: &[String], needle: &str) -> bool {
    args.iter()
        .any(|arg| arg.starts_with("query=") && arg.contains(needle))
}

/// gh signed in to github.com; `me/termul` is a fork of `gnoviawan/termul`.
fn standard(args: &[String]) -> Reply {
    if args[0] == "auth" {
        return ok(AUTH);
    }
    if args[0] == "repo" {
        return if has(args, "github.com/me/termul") {
            ok(FORK_PARENT)
        } else {
            ok(r#"{"parent":null}"#)
        };
    }
    if query_has(args, "search(") {
        return ok(&search_data(4900));
    }
    if query_has(args, "pullRequest(number") {
        return ok(&merge_state("CLEAN"));
    }
    if args[0] == "pr" && args[1] == "checks" {
        return fail("no checks reported on the 'feat/x' branch");
    }
    if args[0] == "pr" && args[1] == "merge" {
        return ok("");
    }
    panic!("unscripted gh call: {args:?}");
}

struct Project {
    dir: tempfile::TempDir,
}

impl Project {
    fn new(remote: Option<&str>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().to_str().unwrap();
        let init = GitTracker::run_git_command(cwd, &["init", "-q"]).expect("git runs");
        assert!(init.status.success());
        if let Some(url) = remote {
            let add = GitTracker::run_git_command(cwd, &["remote", "add", "origin", url]).unwrap();
            assert!(add.status.success());
        }
        Self { dir }
    }

    fn cwd(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }
}

fn service(
    respond: impl Fn(&[String]) -> Reply + Send + Sync + 'static,
) -> (GithubService, CallLog) {
    let (process, log) = fake_gh(respond);
    (GithubService::with_process(process), log)
}

fn repo(owner: &str) -> GithubRepoRef {
    GithubRepoRef {
        host: "github.com".into(),
        owner: owner.into(),
        name: "termul".into(),
    }
}

fn list_request(cwd: String, slot: GithubRepoSlot, refresh: bool) -> GithubListRequest {
    GithubListRequest {
        cwd,
        filter: GithubListFilter {
            repo: slot,
            kind: GithubKindFilter::All,
            state: GithubStateFilter::Open,
            assigned_to_me: false,
            review_requested: false,
        },
        refresh,
    }
}

#[test]
fn context_resolves_origin_and_its_fork_parent() {
    let project = Project::new(Some("git@github.com:me/termul.git"));
    let (service, _) = service(standard);
    let context = service.context(&project.cwd()).expect("context");
    assert_eq!(
        context.repo,
        GithubRepoResolution::Resolved {
            origin: repo("me"),
            upstream: Some(repo("gnoviawan")),
        }
    );
    assert!(
        matches!(context.auth, GithubAuthStatus::Connected { ref account, .. } if account == "octo")
    );
}

#[test]
fn unknown_enterprise_host_gets_a_sign_in_hint_and_no_gh_call() {
    let project = Project::new(Some("https://ghe.corp.example/team/app.git"));
    let (service, log) = service(standard);
    assert_eq!(
        service.context(&project.cwd()).unwrap(),
        GithubContext {
            auth: GithubAuthStatus::Unauthenticated {
                host: "ghe.corp.example".into(),
                login_command: "gh auth login --hostname ghe.corp.example".into(),
            },
            repo: GithubRepoResolution::NotGithub,
        }
    );
    let listed = service.list_items(&list_request(project.cwd(), GithubRepoSlot::Origin, false));
    assert_eq!(
        listed.unwrap_err(),
        super::GithubError::Unauthenticated {
            host: "ghe.corp.example".into()
        }
    );
    assert_eq!(
        log.calls(),
        vec!["- auth status --json hosts"],
        "only the local auth inventory is read; nothing is sent to the remote's host"
    );
}

#[test]
fn other_forges_and_remoteless_projects_are_not_github() {
    for remote in [Some("https://gitlab.com/o/r.git"), None] {
        let project = Project::new(remote);
        let (service, log) = service(standard);
        let context = service.context(&project.cwd()).unwrap();
        assert_eq!(context.repo, GithubRepoResolution::NotGithub, "{remote:?}");
        assert!(
            matches!(context.auth, GithubAuthStatus::Connected { ref host, .. } if host == "github.com")
        );
        assert_eq!(
            service
                .list_items(&list_request(project.cwd(), GithubRepoSlot::Origin, false))
                .unwrap_err()
                .code(),
            "GH_NOT_GITHUB_REPO"
        );
        assert_eq!(log.count_containing("graphql"), 0);
    }
}

#[test]
fn missing_gh_reports_cli_missing() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, _) = service(|_| Err(SpawnFailure::Missing));
    assert_eq!(
        service.context(&project.cwd()).unwrap(),
        GithubContext {
            auth: GithubAuthStatus::CliMissing,
            repo: GithubRepoResolution::Resolved {
                origin: repo("me"),
                upstream: None
            },
        }
    );
    assert_eq!(
        service
            .list_items(&list_request(project.cwd(), GithubRepoSlot::Origin, false))
            .unwrap_err()
            .code(),
        "GH_CLI_MISSING"
    );
}

#[test]
fn list_reads_are_cached_and_refresh_bypasses_the_cache() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service(standard);
    let first = service
        .list_items(&list_request(
            project.cwd(),
            GithubRepoSlot::Upstream,
            false,
        ))
        .unwrap();
    assert_eq!(first.repo, repo("gnoviawan"));
    assert_eq!(
        first
            .items
            .iter()
            .map(|i| (i.number, i.comment_count))
            .collect::<Vec<_>>(),
        vec![(3, 2)]
    );
    assert_eq!(
        log.calls().last().unwrap(),
        "github.com api graphql -f query=… -f q=repo:gnoviawan/termul sort:updated-desc is:open"
    );
    service
        .list_items(&list_request(
            project.cwd(),
            GithubRepoSlot::Upstream,
            false,
        ))
        .unwrap();
    assert_eq!(
        log.count_containing("q=repo:"),
        1,
        "second read is a cache hit"
    );
    service
        .list_items(&list_request(project.cwd(), GithubRepoSlot::Upstream, true))
        .unwrap();
    assert_eq!(log.count_containing("q=repo:"), 2, "refresh goes to GitHub");
}

#[test]
fn low_quota_serves_cached_reads_even_on_refresh() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service(|args| {
        if query_has(args, "search(") {
            ok(&search_data(100))
        } else {
            standard(args)
        }
    });
    let request = list_request(project.cwd(), GithubRepoSlot::Origin, true);
    service.list_items(&request).unwrap();
    service.list_items(&request).unwrap();
    assert_eq!(
        log.count_containing("q=repo:"),
        1,
        "reserve mode keeps the quota for agents"
    );
}

#[test]
fn upstream_slot_of_a_non_fork_is_no_upstream() {
    let project = Project::new(Some("https://github.com/gnoviawan/termul.git"));
    let (service, _) = service(standard);
    let error = service
        .list_items(&list_request(
            project.cwd(),
            GithubRepoSlot::Upstream,
            false,
        ))
        .unwrap_err();
    assert_eq!(error.code(), "GH_NO_UPSTREAM");
}

fn merge_request(cwd: String, action: GithubMergeAction) -> GithubMergeRequest {
    GithubMergeRequest {
        cwd,
        repo: GithubRepoSlot::Origin,
        number: 7,
        action,
    }
}

#[test]
fn direct_merge_is_refused_unless_github_reports_clean() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service(|args| {
        if query_has(args, "pullRequest(number") {
            ok(&merge_state("BLOCKED"))
        } else {
            standard(args)
        }
    });
    let error = service
        .merge(&merge_request(
            project.cwd(),
            GithubMergeAction::Merge {
                method: GithubMergeMethod::Squash,
            },
        ))
        .unwrap_err();
    assert_eq!(
        error,
        super::GithubError::NotMergeable(
            "GitHub reports the pull request as OPEN (BLOCKED)".into()
        )
    );
    assert_eq!(log.count_containing("pr merge"), 0);
}

#[test]
fn merge_pins_the_head_it_read_and_invalidates_cached_reads() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service(standard);
    service
        .list_items(&list_request(project.cwd(), GithubRepoSlot::Origin, false))
        .unwrap();
    let merged = service
        .merge(&merge_request(
            project.cwd(),
            GithubMergeAction::Merge {
                method: GithubMergeMethod::Squash,
            },
        ))
        .unwrap();
    assert_eq!(merged, GithubMergeResult { number: 7 });
    service
        .merge(&merge_request(
            project.cwd(),
            GithubMergeAction::EnableAutoMerge {
                method: GithubMergeMethod::Rebase,
            },
        ))
        .unwrap();
    service
        .merge(&merge_request(
            project.cwd(),
            GithubMergeAction::DisableAutoMerge,
        ))
        .unwrap();
    let merges: Vec<String> = log
        .calls()
        .into_iter()
        .filter(|call| call.contains("pr merge"))
        .collect();
    assert_eq!(
        merges,
        vec![
            "github.com pr merge 7 --repo github.com/me/termul --squash --match-head-commit abc123",
            "github.com pr merge 7 --repo github.com/me/termul --auto --rebase",
            "github.com pr merge 7 --repo github.com/me/termul --disable-auto",
        ]
    );
    service
        .list_items(&list_request(project.cwd(), GithubRepoSlot::Origin, false))
        .unwrap();
    assert_eq!(
        log.count_containing("q=repo:"),
        2,
        "the write dropped the cached list"
    );
}

#[test]
fn a_pr_without_checks_has_no_rollup() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, _) = service(standard);
    let result = service
        .get_checks(&GithubChecksRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            number: 7,
            refresh: false,
        })
        .unwrap();
    assert_eq!(
        (result.head_sha.as_str(), result.rollup, result.checks.len()),
        ("abc123", None, 0)
    );
}

#[test]
fn check_log_retries_without_the_escape_flag_on_older_gh() {
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let (service, log) = service(|args| {
        if args[0] == "api" && has(args, "--allow-escape-sequences") {
            fail("unknown flag: --allow-escape-sequences")
        } else if args[0] == "api" && has(args, "repos/") {
            ok("step 1\n\u{1b}[31m##[error]boom\u{1b}[0m\n")
        } else {
            standard(args)
        }
    });
    let log_tail = service
        .get_check_log(&GithubCheckLogRequest {
            cwd: project.cwd(),
            repo: GithubRepoSlot::Origin,
            job_id: 42,
        })
        .unwrap();
    assert_eq!(
        log_tail,
        GithubCheckLog {
            job_id: 42,
            tail: "step 1\n##[error]boom".into(),
            truncated: false,
        }
    );
    assert_eq!(
        log.calls()[1..],
        [
            "github.com api --allow-escape-sequences repos/me/termul/actions/jobs/42/logs",
            "github.com api repos/me/termul/actions/jobs/42/logs",
        ]
    );
}

#[test]
fn a_sign_in_shows_up_on_the_next_context_read() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let project = Project::new(Some("https://github.com/me/termul.git"));
    let signed_in = Arc::new(AtomicBool::new(false));
    let (service, log) = {
        let signed_in = signed_in.clone();
        service(move |args| {
            if args[0] == "auth" && !signed_in.load(Ordering::SeqCst) {
                ok(r#"{"hosts":{}}"#)
            } else {
                standard(args)
            }
        })
    };
    let before = service.context(&project.cwd()).unwrap();
    assert!(matches!(
        before.auth,
        GithubAuthStatus::Unauthenticated { .. }
    ));
    signed_in.store(true, Ordering::SeqCst);
    let after = service.context(&project.cwd()).unwrap();
    assert!(matches!(after.auth, GithubAuthStatus::Connected { .. }));
    service.context(&project.cwd()).unwrap();
    assert_eq!(
        log.count_containing("auth status"),
        2,
        "a connected inventory is reused within its TTL"
    );
}
