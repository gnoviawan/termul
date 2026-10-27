use std::io::{self, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use super::frame::SessionRpcResult;
use super::gate::{CompletionProvider, CompletionStart, SessionGate};

pub(super) struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("writer").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) type PtyWriter = Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>;

pub(super) fn capture() -> (Arc<Mutex<Vec<u8>>>, PtyWriter) {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer: Box<dyn Write + Send> = Box::new(SharedWriter(bytes.clone()));
    (bytes, Arc::new(AsyncMutex::new(Some(writer))))
}

pub(super) fn trusted_gate(writer: PtyWriter) -> SessionGate {
    let gate = SessionGate::new(writer);
    gate.expect_session("s1".into(), "n1".into());
    gate.mark_trusted_prompt(7, "/repo".into());
    gate
}

pub(super) struct FailingWriter {
    pub(super) fail_on_flush: bool,
}

impl Write for FailingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.fail_on_flush {
            Ok(buf.len())
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "write failed"))
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.fail_on_flush {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "flush failed"))
        } else {
            Ok(())
        }
    }
}

pub(super) fn count(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|window| *window == needle)
        .count()
}

pub(super) fn provider(id: &str, command: &[u8], restorable: bool) -> CompletionProvider {
    CompletionProvider {
        id: id.to_owned(),
        command: command.to_vec(),
        restorable,
    }
}

pub(super) fn capture_gate() -> (Arc<Mutex<Vec<u8>>>, SessionGate) {
    let (bytes, writer) = capture();
    (bytes, trusted_gate(writer))
}

pub(super) async fn start_completion(
    gate: &SessionGate,
    request_id: &str,
    command: &[u8],
) -> CompletionStart {
    gate.request_completion(&request(request_id), &provider("gen", command, true), true)
        .await
}

pub(super) fn outcome_cases() -> [(SessionGate, bool, SessionRpcResult); 3] {
    let missing: PtyWriter = Arc::new(AsyncMutex::new(None));
    let failing: Box<dyn Write + Send> = Box::new(FailingWriter {
        fail_on_flush: false,
    });
    [
        (trusted_gate(missing), true, SessionRpcResult::PreWrite),
        (
            trusted_gate(Arc::new(AsyncMutex::new(Some(failing)))),
            true,
            SessionRpcResult::Partial,
        ),
        (
            trusted_gate(capture().1),
            false,
            SessionRpcResult::NotStarted,
        ),
    ]
}

pub(super) fn spawn_submit(gate: &Arc<SessionGate>) -> tokio::task::JoinHandle<SessionRpcResult> {
    let gate = gate.clone();
    tokio::spawn(async move { gate.submit("git sta", true).await })
}

/// Pauses the first matching write until the test explicitly releases it.
pub(super) struct BlockingWriter {
    pub(super) bytes: Arc<Mutex<Vec<u8>>>,
    pub(super) events: Arc<Mutex<Vec<&'static str>>>,
    pub(super) trigger: Option<Vec<u8>>,
    pub(super) entered: std::sync::mpsc::Sender<()>,
    pub(super) release: std::sync::mpsc::Receiver<()>,
}

impl Write for BlockingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self
            .trigger
            .as_deref()
            .is_some_and(|trigger| buf.windows(trigger.len()).any(|part| part == trigger))
        {
            self.trigger.take();
            self.entered.send(()).expect("write entered");
            self.release.recv().expect("release write");
        }
        self.bytes.lock().expect("bytes").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.events.lock().expect("events").push("write-done");
        Ok(())
    }
}

pub(super) struct BlockingGate {
    pub(super) gate: Arc<SessionGate>,
    pub(super) bytes: Arc<Mutex<Vec<u8>>>,
    pub(super) events: Arc<Mutex<Vec<&'static str>>>,
    pub(super) entered: mpsc::Receiver<()>,
    pub(super) release: mpsc::Sender<()>,
}

pub(super) fn blocking_gate(completion: bool) -> BlockingGate {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let trigger = if completion {
        b"GEN-ONE".to_vec()
    } else {
        super::CLEAR_LINE_SEQUENCE.as_bytes().to_vec()
    };
    let writer: Box<dyn Write + Send> = Box::new(BlockingWriter {
        bytes: bytes.clone(),
        events: events.clone(),
        trigger: Some(trigger),
        entered: entered_tx,
        release: release_rx,
    });
    BlockingGate {
        gate: Arc::new(trusted_gate(Arc::new(AsyncMutex::new(Some(writer))))),
        bytes,
        events,
        entered,
        release,
    }
}

pub(super) fn spawn_gate_write(
    gate: &Arc<SessionGate>,
    completion: bool,
) -> tokio::task::JoinHandle<SessionRpcResult> {
    let gate = gate.clone();
    tokio::spawn(async move {
        if completion {
            start_completion(&gate, "r1", b"GEN-ONE").await.result
        } else {
            gate.submit("git sta", true).await
        }
    })
}

pub(super) fn restore_during_write(
    fixture: &BlockingGate,
) -> (std::thread::JoinHandle<()>, mpsc::Receiver<()>, bool) {
    let gate = fixture.gate.clone();
    let events = fixture.events.clone();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let restoring = std::thread::spawn(move || {
        attempt_tx.send(()).expect("restore attempt");
        gate.restore_failed("unknown");
        events.lock().expect("events").push("restore-done");
        done_tx.send(()).expect("restore completed");
    });
    attempt_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("restore started");
    let blocked = matches!(
        done_rx.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    );
    (restoring, done_rx, blocked)
}

pub(super) fn expected_write(completion: bool) -> Vec<u8> {
    if completion {
        b"\x1b0Di\x15GEN-ONE r1 3 4 74657374\r".to_vec()
    } else {
        format!("{}git sta\r", super::CLEAR_LINE_SEQUENCE).into_bytes()
    }
}

#[derive(Clone, Debug, Default)]
struct RunningChild(Arc<(Mutex<bool>, std::sync::Condvar)>);

impl portable_pty::ChildKiller for RunningChild {
    fn kill(&mut self) -> io::Result<()> {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl portable_pty::Child for RunningChild {
    fn try_wait(&mut self) -> io::Result<Option<portable_pty::ExitStatus>> {
        Ok(self
            .0
             .0
            .lock()
            .unwrap()
            .then(|| portable_pty::ExitStatus::with_exit_code(0)))
    }

    fn wait(&mut self) -> io::Result<portable_pty::ExitStatus> {
        let mut exited = self.0 .0.lock().unwrap();
        while !*exited {
            exited = self.0 .1.wait(exited).unwrap();
        }
        Ok(portable_pty::ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

pub(super) async fn rpc_terminal() -> (Arc<crate::pty::PtyManager>, String, std::io::PipeWriter) {
    let pty = crate::web::test_pty_manager();
    let (reader, keep_alive) = std::io::pipe().unwrap();
    let spawned = pty
        .adopt_external(crate::pty::manager::ExternalTerminal {
            reader: Box::new(reader),
            writer: Box::new(SharedWriter(Arc::new(Mutex::new(Vec::new())))),
            child: Box::new(RunningChild::default()),
            resizer: Arc::new(|_, _| Ok(())),
            shell: "test".into(),
            cwd: "/repo".into(),
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
    (pty, spawned.info.id, keep_alive)
}

pub(super) fn finish(gate: &SessionGate, request_id: &str, output: String) {
    gate.finish_completion(super::frame::CompletionResult {
        session_id: "s1".into(),
        nonce: "n1".into(),
        request_id: request_id.into(),
        buffer_revision: 3,
        cursor: 4,
        prompt_generation: 7,
        cwd: "/repo".into(),
        output,
    });
}

pub(super) fn request(id: &str) -> super::gate::CompletionRequest {
    super::gate::CompletionRequest {
        request_id: id.into(),
        buffer_revision: 3,
        cursor: 4,
        draft: "test".into(),
        prompt_generation: 7,
        cwd: "/repo".into(),
    }
}
