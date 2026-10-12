//! Behavior of the commit stamp against real repositories: only a real trailer
//! is a stamp, a bounded search is not capped, and two Termul commits naming
//! one `expectedHead` cannot both land.

use super::*;

fn run(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = GitTracker::run_git_command(cwd.to_str().unwrap(), args).expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn repo(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "termul-commit-stamp-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    run(&dir, &["init", "-q"]);
    run(&dir, &["config", "user.email", "t@example.com"]);
    run(&dir, &["config", "user.name", "Test"]);
    run(&dir, &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    run(&dir, &["add", "a.txt"]);
    run(&dir, &["commit", "-qm", "seed"]);
    dir
}

fn stage_change(repo: &std::path::Path, content: &str) {
    std::fs::write(repo.join("a.txt"), content).unwrap();
    run(repo, &["add", "a.txt"]);
}

#[test]
fn a_prose_line_that_looks_like_the_stamp_is_not_a_stamp() {
    let repo = repo("spoof");
    let cwd = repo.to_str().unwrap();
    stage_change(&repo, "two\n");
    // The look-alike sits in the body, not in the final trailer paragraph.
    run(
        &repo,
        &["commit", "-qm", "spoofed\n\nTermul-Command-Id: victim-1\n\nmore prose follows"],
    );
    assert_eq!(find_stamped_commit(cwd, "victim-1", None), None);

    // A real stamp is found, by exact value only.
    stage_change(&repo, "three\n");
    git_commit_stamped(
        cwd,
        "real",
        "",
        false,
        &CommitStamp { command_id: Some("victim-1x"), expected_head: None },
    )
    .unwrap();
    assert_eq!(find_stamped_commit(cwd, "victim-1", None), None);
    assert!(find_stamped_commit(cwd, "victim-1x", None).is_some());
}

#[test]
fn an_option_shaped_expected_head_never_reaches_the_search() {
    let repo = repo("inject");
    let victim = repo.join("pwned.txt");
    let head = format!("--output={}", victim.display());
    assert_eq!(find_stamped_commit(repo.to_str().unwrap(), "x", Some(&head)), None);
    assert!(!victim.exists());
}

#[test]
fn a_bounded_search_is_not_capped_but_an_unbounded_one_is() {
    let repo = repo("cap");
    let cwd = repo.to_str().unwrap();
    let base = head_sha(cwd);
    stage_change(&repo, "stamped\n");
    git_commit_stamped(
        cwd,
        "stamped",
        "",
        false,
        &CommitStamp { command_id: Some("deep-1"), expected_head: Some(&base) },
    )
    .unwrap();
    // More commits than the unbounded cap on top of the stamped one.
    for _ in 0..205 {
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "filler"]);
    }
    assert!(find_stamped_commit(cwd, "deep-1", Some(&base)).is_some());
    assert_eq!(find_stamped_commit(cwd, "deep-1", None), None);
}

#[test]
fn two_commits_naming_one_expected_head_land_exactly_once() {
    let repo = repo("race");
    let cwd = repo.to_str().unwrap().to_string();
    let base = head_sha(&cwd);
    stage_change(&repo, "raced\n");

    let attempts: Vec<_> = ["race-a", "race-b"]
        .into_iter()
        .map(|id| {
            let (cwd, base) = (cwd.clone(), base.clone());
            std::thread::spawn(move || {
                git_commit_stamped(
                    &cwd,
                    "raced",
                    "",
                    false,
                    &CommitStamp { command_id: Some(id), expected_head: Some(&base) },
                )
            })
        })
        .collect();
    let results: Vec<_> = attempts.into_iter().map(|t| t.join().unwrap()).collect();

    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "{results:?}");
    assert!(
        results
            .iter()
            .any(|r| matches!(r, Err(CommitFailure::PreconditionFailed { .. }))),
        "the loser is refused by the stale head, not by a later error: {results:?}"
    );
    assert_eq!(run(&repo, &["rev-list", "--count", "HEAD"]), "2");
}
