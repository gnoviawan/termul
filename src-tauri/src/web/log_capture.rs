//! Test support: what a code path logged, through `tracing` or `log`.

use std::future::Future;
use std::io;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::layer::SubscriberExt;

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl io::Write for Sink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("log sink").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Run `work` and return its output with every `tracing` event it emitted on
/// this thread, one per line. Use on a current-thread runtime (the default
/// `#[tokio::test]`), where the whole future runs on the capturing thread.
pub(crate) async fn capture_tracing<F: Future>(work: F) -> (F::Output, String) {
    // tracing-core 0.1.36's single-dispatcher fast path registers callsites
    // against the registering thread's default, which may have no subscriber.
    // Keep an inert dispatcher alive so every capture uses the registry of live
    // dispatchers, including when another thread first encounters a callsite.
    // Rebuilding after set_default alone cannot protect those new callsites.
    static INTEREST_ANCHOR: OnceLock<tracing::Dispatch> = OnceLock::new();
    INTEREST_ANCHOR.get_or_init(|| {
        tracing::Dispatch::new(
            tracing_subscriber::registry().with(tracing_subscriber::filter::LevelFilter::OFF),
        )
    });

    let sink = Sink::default();
    let writer = sink.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    let output = work.await;
    drop(guard);
    let text = String::from_utf8_lossy(&sink.0.lock().expect("log sink")).into_owned();
    (output, text)
}

struct LogCapture(Mutex<Vec<String>>);

impl log::Log for LogCapture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        self.0
            .lock()
            .expect("log lines")
            .push(format!("{} {}", record.target(), record.args()));
    }

    fn flush(&self) {}
}

fn log_capture() -> &'static LogCapture {
    static CAPTURE: OnceLock<&'static LogCapture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let capture: &'static LogCapture = Box::leak(Box::new(LogCapture(Mutex::default())));
        log::set_logger(capture).expect("no other test installs a global `log` logger");
        log::set_max_level(log::LevelFilter::Trace);
        capture
    })
}

/// Every `log` record emitted so far in this process, from any test. Call
/// once before the code under test so the capture is installed, then read
/// the lines after it.
pub(crate) fn logged_lines() -> Vec<String> {
    log_capture().0.lock().expect("log lines").clone()
}
