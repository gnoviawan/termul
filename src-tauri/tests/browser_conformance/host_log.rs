//! Prints the automation host's own log lines to stderr, so a CI failure
//! shows what the host decided. Host log lines carry codes and key names,
//! never values.

use std::sync::Mutex;

use log::{Level, LevelFilter, Log, Metadata, Record};

const HOST_TARGET: &str = "termul_manager_lib::browser_automation";
const PERMISSION_TARGET: &str = "termul_manager_lib::browser_tab_permissions";

/// Responses the web-permission handler logged, as `(kind, response)`.
static PERMISSION_RESPONSES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

struct HostLog;

impl Log for HostLog {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Warn
            || (metadata.level() <= Level::Info && metadata.target().starts_with(HOST_TARGET))
    }

    fn log(&self, record: &Record<'_>) {
        if record.target() == PERMISSION_TARGET {
            record_permission(&record.args().to_string());
        }
        if self.enabled(record.metadata()) {
            eprintln!("host {} {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|part| part.strip_prefix(key)?.strip_prefix('='))
}

fn record_permission(line: &str) {
    if let (Some(kind), Some(response)) = (field(line, "kind"), field(line, "response")) {
        PERMISSION_RESPONSES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((kind.to_string(), response.to_string()));
    }
}

/// The response the handler gave the latest request of `kind`, if any came.
pub fn permission_response(kind: &str) -> Option<String> {
    PERMISSION_RESPONSES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .rev()
        .find(|(logged, _)| logged == kind)
        .map(|(_, response)| response.clone())
}

pub fn install() {
    if log::set_logger(&HostLog).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}
