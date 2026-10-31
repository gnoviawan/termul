use std::path::{Path, PathBuf};

use super::fake_gh::{fail, fake_gh, ok, service_with, Reply, AUTH};
use super::types::*;
use super::GithubError;
use crate::trackers::GitTracker;

fn git(cwd: &Path, args: &[&str]) -> String {
    let mut full = vec![
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
    ];
    full.extend_from_slice(args);
    let output = GitTracker::run_git_command_with_timeout(cwd.to_str().unwrap(), &full, 10_000)
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A repository on `main` with a `feat` commit (the PR head) and a chat
/// worktree `chat/abc` under `.termul/worktrees/abc`, still on `main`.
struct Checkout {
    _dir: tempfile::TempDir,
    main: PathBuf,
    worktree: PathBuf,
    base: String,
    pr_head: String,
}

impl Checkout {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().canonicalize().unwrap().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(
            &main,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/me/termul.git",
            ],
        );
        std::fs::write(main.join("a.txt"), "a").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-q", "-m", "base"]);
        let base = git(&main, &["rev-parse", "HEAD"]);
        git(&main, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(main.join("b.txt"), "b").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-q", "-m", "pr"]);
        let pr_head = git(&main, &["rev-parse", "HEAD"]);
        git(&main, &["checkout", "-q", "main"]);
        let worktree = main.join(".termul").join("worktrees").join("abc");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "chat/abc",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        Self {
            _dir: dir,
            main,
            worktree,
            base,
            pr_head,
        }
    }

    fn cwd(&self) -> String {
        self.worktree.to_string_lossy().into_owned()
    }

    fn head(&self) -> String {
        git(&self.worktree, &["rev-parse", "HEAD"])
    }
}

fn pr_head(
    cross: bool,
    maintainer_can_modify: bool,
    owner: &str,
    permission: &str,
    head_ref: &str,
    oid: &str,
) -> String {
    pr_head_on(
        "ADMIN",
        cross,
        maintainer_can_modify,
        owner,
        permission,
        head_ref,
        oid,
    )
}

/// `pr_head` where the viewer has `base_permission` on the base repository.
fn pr_head_on(
    base_permission: &str,
    cross: bool,
    maintainer_can_modify: bool,
    owner: &str,
    permission: &str,
    head_ref: &str,
    oid: &str,
) -> String {
    serde_json::json!({ "data": { "repository": { "viewerPermission": base_permission, "pullRequest": {
        "headRefName": head_ref,
        "headRefOid": oid,
        "isCrossRepository": cross,
        "maintainerCanModify": maintainer_can_modify,
        "headRepository": { "name": "termul", "owner": { "login": owner }, "viewerPermission": permission }
    } } } })
    .to_string()
}

/// `gh pr checkout --detach` after its fetch: `git checkout --detach`, which
/// refuses to overwrite local changes.
fn detach(worktree: &Path, sha: &str) -> Reply {
    let output = GitTracker::run_git_command_with_timeout(
        worktree.to_str().unwrap(),
        &["checkout", "-q", "--detach", sha],
        10_000,
    )
    .expect("git runs");
    if output.status.success() {
        ok("")
    } else {
        fail(&String::from_utf8_lossy(&output.stderr))
    }
}

/// gh whose PR #7 is `head`; `pr checkout` runs `on_checkout` (git in the worktree).
fn gh(
    head: String,
    on_checkout: impl Fn() -> Reply + Send + Sync + 'static,
) -> impl Fn(&[String]) -> Reply + Send + Sync + 'static {
    move |args| {
        if args[0] == "auth" {
            return ok(AUTH);
        }
        if args
            .iter()
            .any(|a| a.starts_with("query=") && a.contains("headRepository"))
        {
            return ok(&head);
        }
        if args[0] == "pr" && args[1] == "checkout" {
            return on_checkout();
        }
        panic!("unscripted gh call: {args:?}");
    }
}

fn request(cwd: String) -> GithubCheckoutPrRequest {
    GithubCheckoutPrRequest {
        cwd,
        repo: GithubRepoSlot::Origin,
        number: 7,
    }
}

#[test]
fn same_repo_pr_moves_the_chat_branch_and_pushes_through_origin() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    let (service, log) = service_with(fake_gh(gh(
        pr_head(false, false, "me", "ADMIN", "feat", &repo.pr_head),
        move || detach(&worktree, &sha),
    )));
    let result = service.checkout_pr(&request(repo.cwd())).unwrap();
    assert_eq!(
        result,
        GithubCheckoutPrResult {
            head_sha: repo.pr_head.clone(),
            head_ref_name: "feat".into(),
            push_command: "git push origin HEAD:feat".into(),
        }
    );
    assert_eq!(
        log.calls().last().unwrap(),
        "github.com pr checkout 7 --repo github.com/me/termul --detach"
    );
    assert_eq!(log.cwds(), vec![repo.cwd()]);
    assert_eq!(
        git(&repo.worktree, &["symbolic-ref", "--short", "HEAD"]),
        "chat/abc"
    );
    assert_eq!(
        git(&repo.worktree, &["rev-parse", "chat/abc"]),
        repo.pr_head
    );
}

#[test]
fn fork_pr_without_maintainer_edits_is_blocked_before_git_is_touched() {
    let repo = Checkout::new();
    let (service, log) = service_with(fake_gh(gh(
        pr_head(true, false, "stranger", "READ", "fix", &repo.pr_head),
        || panic!("checkout must not run"),
    )));
    let error = service.checkout_pr(&request(repo.cwd())).unwrap_err();
    assert_eq!(error.code(), "GH_FORK_PUSH_BLOCKED");
    assert_eq!(
        error.to_string(),
        "Pull request #7 comes from the fork stranger/termul, which does not allow edits by maintainers, \
         so an agent's commits could not be pushed to its branch. Ask the author to enable \
         \"Allow edits by maintainers\"."
    );
    assert_eq!(log.count_containing("pr checkout"), 0);
    assert_eq!(repo.head(), repo.base);
}

#[test]
fn fork_pr_open_to_maintainers_pushes_to_the_fork_remote() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    git(
        &repo.main,
        &[
            "remote",
            "add",
            "forker",
            "git@github.com:forker/termul.git",
        ],
    );
    let (service, _) = service_with(fake_gh(gh(
        pr_head(true, true, "forker", "READ", "fix$(id);x", &repo.pr_head),
        move || detach(&worktree, &sha),
    )));
    let result = service.checkout_pr(&request(repo.cwd())).unwrap();
    assert_eq!(result.push_command, "git push forker 'HEAD:fix$(id);x'");
}

#[test]
fn a_remote_whose_push_url_is_elsewhere_is_not_the_push_remote() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    git(
        &repo.main,
        &[
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://github.com/someone/else.git",
        ],
    );
    let (service, _) = service_with(fake_gh(gh(
        pr_head(false, false, "me", "ADMIN", "feat", &repo.pr_head),
        move || detach(&worktree, &sha),
    )));
    let result = service.checkout_pr(&request(repo.cwd())).unwrap();
    assert_eq!(
        result.push_command,
        "git push https://github.com/me/termul.git HEAD:feat"
    );
}

#[test]
fn fork_pr_open_to_maintainers_is_blocked_without_write_access_to_the_base() {
    let repo = Checkout::new();
    let (service, log) = service_with(fake_gh(gh(
        pr_head_on("READ", true, true, "forker", "READ", "fix", &repo.pr_head),
        || panic!("checkout must not run"),
    )));
    let error = service.checkout_pr(&request(repo.cwd())).unwrap_err();
    assert_eq!(
        error,
        GithubError::ForkPushBlocked(
            "Pull request #7 comes from the fork forker/termul, which allows edits only by maintainers of me/termul, \
             and you cannot push to me/termul, so an agent's commits could not be pushed to its branch."
                .into()
        )
    );
    assert_eq!(log.count_containing("pr checkout"), 0);
}

#[test]
fn same_repo_pr_is_blocked_without_write_access() {
    let repo = Checkout::new();
    let (service, _) = service_with(fake_gh(gh(
        pr_head_on("READ", false, false, "me", "READ", "feat", &repo.pr_head),
        || panic!("checkout must not run"),
    )));
    let error = service.checkout_pr(&request(repo.cwd())).unwrap_err();
    assert_eq!(
        error,
        GithubError::ForkPushBlocked(
            "You cannot push to me/termul, so an agent's commits could not be pushed to the branch of pull request #7."
                .into()
        )
    );
}

#[test]
fn an_edit_made_during_checkout_is_kept() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    let (service, _) = service_with(fake_gh(gh(
        pr_head(false, false, "me", "ADMIN", "feat", &repo.pr_head),
        move || {
            std::fs::write(worktree.join("a.txt"), "agent edit").unwrap();
            detach(&worktree, &sha)
        },
    )));
    let result = service.checkout_pr(&request(repo.cwd())).unwrap();
    assert_eq!(result.head_sha, repo.pr_head);
    assert_eq!(
        std::fs::read_to_string(repo.worktree.join("a.txt")).unwrap(),
        "agent edit"
    );
}

#[test]
fn an_edit_the_pr_head_would_overwrite_stops_the_checkout() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    let (service, _) = service_with(fake_gh(gh(
        pr_head(false, false, "me", "ADMIN", "feat", &repo.pr_head),
        move || {
            std::fs::write(worktree.join("b.txt"), "agent file").unwrap();
            detach(&worktree, &sha)
        },
    )));
    let error = service.checkout_pr(&request(repo.cwd())).unwrap_err();
    assert_eq!(error.code(), "GH_FAILED");
    assert_eq!(repo.head(), repo.base);
    assert_eq!(
        git(&repo.worktree, &["symbolic-ref", "--short", "HEAD"]),
        "chat/abc"
    );
    assert_eq!(
        std::fs::read_to_string(repo.worktree.join("b.txt")).unwrap(),
        "agent file"
    );
}

#[test]
fn own_fork_pr_is_pushable_and_falls_back_to_the_fork_url() {
    let repo = Checkout::new();
    let (worktree, sha) = (repo.worktree.clone(), repo.pr_head.clone());
    let (service, _) = service_with(fake_gh(gh(
        pr_head(true, false, "octo", "ADMIN", "mine", &repo.pr_head),
        move || detach(&worktree, &sha),
    )));
    let result = service.checkout_pr(&request(repo.cwd())).unwrap();
    assert_eq!(
        result.push_command,
        "git push https://github.com/octo/termul.git HEAD:mine"
    );
}

#[test]
fn a_head_that_moved_during_checkout_is_an_error() {
    let repo = Checkout::new();
    let (service, _) = service_with(fake_gh(gh(
        pr_head(
            false,
            false,
            "me",
            "ADMIN",
            "feat",
            "0000000000000000000000000000000000000000",
        ),
        || ok(""),
    )));
    let error = service.checkout_pr(&request(repo.cwd())).unwrap_err();
    assert_eq!(error.code(), "GH_FAILED");
    assert!(
        error.to_string().contains("changed during checkout"),
        "{error}"
    );
}

#[test]
fn only_clean_termul_chat_worktrees_are_accepted() {
    let repo = Checkout::new();
    let (service, log) = service_with(fake_gh(gh(String::new(), || panic!("no checkout"))));
    let code = |cwd: &Path| {
        service
            .checkout_pr(&request(cwd.to_string_lossy().into_owned()))
            .unwrap_err()
    };

    assert_eq!(
        code(&repo.main),
        GithubError::NotTermulWorktree(repo.main.to_string_lossy().into_owned())
    );
    let outside = repo.main.parent().unwrap().join("elsewhere");
    git(
        &repo.main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "chat/out",
            outside.to_str().unwrap(),
            "main",
        ],
    );
    assert_eq!(code(&outside).code(), "PATH_VALIDATION_FAILED");

    let other = repo.main.join(".termul").join("worktrees").join("feature");
    git(
        &repo.main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "my-feature",
            other.to_str().unwrap(),
            "main",
        ],
    );
    assert_eq!(
        code(&other).to_string(),
        "The worktree is not on a chat branch (my-feature), so Termul will not reset it"
    );

    std::fs::write(repo.worktree.join("a.txt"), "edited").unwrap();
    assert_eq!(
        code(&repo.worktree).to_string(),
        "The worktree has uncommitted changes; commit or discard them before checking out a pull request"
    );
    assert!(log.calls().is_empty(), "{:?}", log.calls());
}
