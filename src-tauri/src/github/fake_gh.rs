//! A scripted `gh` for unit tests: answers by argument list and records
//! every call it receives.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::runner::{GhCall, GhOutput, GhProcess, SpawnFailure};

pub(super) type Reply = Result<GhOutput, SpawnFailure>;

#[derive(Clone, Default)]
pub(super) struct CallLog(Arc<Mutex<Vec<String>>>);

impl CallLog {
    /// Each call as `<GH_HOST or -> <args…>`, the query text elided.
    pub fn calls(&self) -> Vec<String> {
        self.0.lock().clone()
    }

    pub fn count_containing(&self, needle: &str) -> usize {
        self.0
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
    F: Fn(&[String]) -> Reply + Send + Sync,
{
    fn run(&self, call: &GhCall, _timeout: Duration) -> Reply {
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
        self.log.0.lock().push(format!(
            "{} {}",
            call.host.as_deref().unwrap_or("-"),
            rendered.join(" ")
        ));
        (self.respond)(&call.args)
    }
}

pub(super) fn fake_gh(
    respond: impl Fn(&[String]) -> Reply + Send + Sync + 'static,
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
