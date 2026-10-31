//! A scripted `gh` for unit tests: answers by argument list and records
//! every call it receives.

use std::sync::Arc;

use parking_lot::Mutex;

use super::runner::{GhCall, GhOutput, GhProcess, SpawnFailure};
use super::service::GithubService;
use crate::trackers::GitTracker;

pub(super) type Reply = Result<GhOutput, SpawnFailure>;

#[derive(Clone, Default)]
pub(super) struct CallLog {
    lines: Arc<Mutex<Vec<String>>>,
    stdins: Arc<Mutex<Vec<String>>>,
    cwds: Arc<Mutex<Vec<String>>>,
}

impl CallLog {
    /// Each call as `<GH_HOST or -> <args…>`, the query text elided.
    pub fn calls(&self) -> Vec<String> {
        self.lines.lock().clone()
    }

    /// The stdin of every call that had one, in order.
    pub fn stdins(&self) -> Vec<String> {
        self.stdins.lock().clone()
    }

    /// The working directory of every call that set one, in order.
    pub fn cwds(&self) -> Vec<String> {
        self.cwds.lock().clone()
    }

    pub fn count_containing(&self, needle: &str) -> usize {
        self.lines
            .lock()
            .iter()
            .filter(|call| call.contains(needle))
            .count()
    }
}

struct FakeGh<F> {
    log: CallLog,
    respond: F,
}

impl<F> GhProcess for FakeGh<F>
where
    F: Fn(&[String], Option<&str>) -> Reply + Send + Sync,
{
    fn run(&self, call: &GhCall) -> Reply {
        let rendered: Vec<String> = call
            .args
            .iter()
            .map(|arg| {
                if arg.starts_with("query=") {
                    "query=…".to_string()
                } else {
                    arg.clone()
                }
            })
            .collect();
        if let Some(input) = &call.stdin {
            self.log
                .stdins
                .lock()
                .push(String::from_utf8_lossy(input).into_owned());
        }
        if let Some(cwd) = &call.cwd {
            self.log.cwds.lock().push(cwd.clone());
        }
        self.log.lines.lock().push(format!(
            "{} {}",
            call.host.as_deref().unwrap_or("-"),
            rendered.join(" ")
        ));
        let stdin = call.stdin.as_deref().map(String::from_utf8_lossy);
        (self.respond)(&call.args, stdin.as_deref())
    }
}

pub(super) fn fake_gh(
    respond: impl Fn(&[String]) -> Reply + Send + Sync + 'static,
) -> (Box<dyn GhProcess>, CallLog) {
    fake_gh_with_stdin(move |args, _| respond(args))
}

/// A fake whose replies can depend on the call's stdin.
pub(super) fn fake_gh_with_stdin(
    respond: impl Fn(&[String], Option<&str>) -> Reply + Send + Sync + 'static,
) -> (Box<dyn GhProcess>, CallLog) {
    let log = CallLog::default();
    (
        Box::new(FakeGh {
            log: log.clone(),
            respond,
        }),
        log,
    )
}

/// `gh auth status --json hosts` signed in to github.com as `octo`.
pub(super) const AUTH: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octo","tokenSource":"keyring","scopes":"repo, read:org"}]}}"#;

/// A temporary git repository, optionally with an `origin` remote.
pub(super) struct Project {
    pub dir: tempfile::TempDir,
}

impl Project {
    pub fn new(remote: Option<&str>) -> Self {
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

    pub fn cwd(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }
}

pub(super) fn service_with(process: (Box<dyn GhProcess>, CallLog)) -> (GithubService, CallLog) {
    (GithubService::with_process(process.0), process.1)
}

pub(super) fn ok(stdout: &str) -> Reply {
    Ok(GhOutput {
        success: true,
        stdout: stdout.as_bytes().to_vec(),
        stderr: String::new(),
    })
}

pub(super) fn fail(stderr: &str) -> Reply {
    Ok(GhOutput {
        success: false,
        stdout: Vec::new(),
        stderr: stderr.to_string(),
    })
}

pub(super) fn has(args: &[String], needle: &str) -> bool {
    args.iter()
        .any(|arg| arg == needle || arg.starts_with(needle))
}
