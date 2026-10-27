use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use super::command_editor::RESTORE_PROMPT;
use super::command_editor::SESSION_RPC_NAMES;
use super::command_editor::{authentic_session_events, forward_or_buffer_hub_event};
use super::{json, mpsc, ConnectionContext, Message, Request};
use crate::pty::session_protocol::frame::SessionRpcResult;
use crate::pty::session_protocol::gate::{AuthenticSession, CompletionRequest, SessionPhase};
use crate::pty::session_protocol::gate::{CompletionProvider, SessionGate};
use crate::web::capabilities::terminal_request_is_view;

struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("writer").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn session_rpcs_are_not_view_requests() {
    assert_eq!(
        SESSION_RPC_NAMES,
        [
            "command_editor_submit",
            "command_editor_request_completion",
            "command_editor_cancel_completion",
        ]
    );
    for name in SESSION_RPC_NAMES {
        assert!(
            !terminal_request_is_view(name),
            "{name} must not be a view request"
        );
    }

    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer: Box<dyn Write + Send> = Box::new(SharedWriter(bytes.clone()));
    let gate = SessionGate::new(Arc::new(AsyncMutex::new(Some(writer))));
    gate.mark_trusted_prompt(1, "/tmp".into());

    assert_eq!(
        gate.request_completion(
            &serde_json::from_value(serde_json::json!({"requestId":"r1", "bufferRevision":1, "cursor":7, "draft":"git status", "promptGeneration":1, "cwd":"/tmp"})).unwrap(),
            &CompletionProvider {
                id: "gen".to_owned(),
                command: b"GEN-ONE".to_vec(),
                restorable: true,
            },
            false,
        )
        .await
        .result,
        SessionRpcResult::NotStarted
    );
    assert_eq!(
        gate.submit("git sta", false).await,
        SessionRpcResult::NotStarted
    );
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "a view-only caller writes nothing"
    );
}

#[tokio::test]
async fn viewer_cannot_restore_the_prompt() {
    assert_eq!(RESTORE_PROMPT, "command_editor_restore_prompt");
    assert!(
        !terminal_request_is_view(RESTORE_PROMPT),
        "restore prompt must not be a view request"
    );

    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer: Box<dyn Write + Send> = Box::new(SharedWriter(bytes.clone()));
    let gate = SessionGate::new(Arc::new(AsyncMutex::new(Some(writer))));
    gate.mark_trusted_prompt(1, "/tmp".into());

    assert_eq!(
        gate.restore_prompt(false).await,
        SessionRpcResult::NotStarted
    );
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "a view-only caller cannot restore the prompt"
    );
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

struct AdoptedSession {
    id: String,
    claim: String,
    bytes: Arc<Mutex<Vec<u8>>>,
    _keep_alive: std::io::PipeWriter,
}

async fn adopt_session(state: &super::AppState) -> AdoptedSession {
    use crate::pty::manager::ExternalTerminal;
    let (reader, keep_alive) = std::io::pipe().unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let spawned = state
        .pty
        .adopt_external(ExternalTerminal {
            reader: Box::new(reader),
            writer: Box::new(SharedWriter(bytes.clone())),
            child: Box::new(RunningChild::default()),
            resizer: Arc::new(|_, _| Ok(())),
            shell: "test".into(),
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
    let gate = &state.pty.get(&spawned.info.id).unwrap().session_gate;
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    gate.mark_trusted_prompt(1, "/tmp".into());
    gate.observe_output(b"\x1b[?2004h");
    gate.set_completion_providers(vec![CompletionProvider {
        id: "gen".into(),
        command: b"GEN-ONE".to_vec(),
        restorable: true,
    }]);
    AdoptedSession {
        id: spawned.info.id,
        claim: spawned.claim,
        bytes,
        _keep_alive: keep_alive,
    }
}

fn session_requests(id: &str) -> [(&'static str, serde_json::Value); 4] {
    use super::command_editor::{CANCEL_COMPLETION, REQUEST_COMPLETION, SUBMIT};
    use serde_json::json;
    [
        (SUBMIT, json!({"terminalId": id, "draft": "git sta"})),
        (
            REQUEST_COMPLETION,
            json!({"terminalId": id, "requestId": "r1",
            "bufferRevision": 1, "cursor": 7, "draft":"git status", "promptGeneration": 1, "cwd": "/tmp"}),
        ),
        (
            CANCEL_COMPLETION,
            json!({"terminalId": id, "requestId": "r1"}),
        ),
        (RESTORE_PROMPT, json!({"terminalId": id})),
    ]
}

fn desktop_session_webview(
    state: &super::AppState,
) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(state.pty.clone())
        .invoke_handler(tauri::generate_handler![
            crate::commands::command_editor::command_editor_submit,
            crate::commands::command_editor::command_editor_request_completion,
            crate::commands::command_editor::command_editor_cancel_completion,
            crate::commands::command_editor::command_editor_restore_prompt,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app");
    tauri::WebviewWindowBuilder::new(&app, "session-rpcs", Default::default())
        .build()
        .expect("build mock webview")
}

async fn desktop_session_invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    name: &str,
    payload: &serde_json::Value,
) -> serde_json::Value {
    let body = if name == super::command_editor::REQUEST_COMPLETION {
        serde_json::json!({"terminalId": payload["terminalId"], "request": payload})
    } else {
        payload.clone()
    };
    let webview = webview.clone();
    let request = tauri::webview::InvokeRequest {
        cmd: name.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_owned(),
    };
    tokio::task::spawn_blocking(move || {
        tauri::test::get_ipc_response(&webview, request)
            .expect("session invoke succeeds")
            .deserialize::<serde_json::Value>()
            .expect("session response")
    })
    .await
    .expect("invoke worker")
}

fn assert_session_effects(state: &super::AppState, session: &AdoptedSession, step: usize) {
    let gate = &state.pty.get(&session.id).unwrap().session_gate;
    assert!(!gate.generator_active());
    if step == 3 {
        use crate::pty::session_protocol::{CLEAR_LINE_SEQUENCE, RESTORE_PROMPT_SEQUENCE};
        let bytes = session.bytes.lock().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with(&format!(
            "{CLEAR_LINE_SEQUENCE}\x1b[200~git sta\x1b[201~\r\x1b0Di\x15GEN-ONE "
        )));
        assert!(text.ends_with(&format!(" 1 7 67697420737461\r{RESTORE_PROMPT_SEQUENCE}")));
        assert_eq!(
            bytes.windows(7).filter(|part| *part == b"git sta").count(),
            1
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn session_rpc_names_reach_the_gate() {
    let state = super::tests::gate_test_state(None);
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let webview = desktop_session_webview(&state);
    for desktop in [false, true] {
        let session = adopt_session(&state).await;
        super::tests::attach_terminal(&state, &tx, &mut ctx, &session.id, &session.claim).await;
        for (step, (name, payload)) in session_requests(&session.id).into_iter().enumerate() {
            let terminal = state.pty.get(&session.id).unwrap();
            let completing = if step == 1 {
                terminal.session_gate.mark_trusted_prompt(1, "/tmp".into());
                let gate = terminal.session_gate.clone();
                let bytes = session.bytes.clone();
                Some(tokio::spawn(async move {
                    while !gate.generator_active() {
                        tokio::task::yield_now().await;
                    }
                    gate.finish_completion(completion_from_trigger(&bytes));
                }))
            } else {
                None
            };
            let result = if desktop {
                desktop_session_invoke(&webview, name, &payload).await
            } else {
                let request = super::Request {
                    id: format!("session-{step}"),
                    type_: name.into(),
                    payload,
                    command_id: None,
                };
                super::handle(request, &state, &tx, &mut ctx).await.unwrap()
            };
            if let Some(completing) = completing {
                completing.await.unwrap();
            }
            let result = if !desktop && step == 1 {
                loop {
                    let axum::extract::ws::Message::Text(text) = rx.recv().await.unwrap() else {
                        continue;
                    };
                    let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if reply["id"] == "session-1" {
                        break reply["data"].clone();
                    }
                }
            } else {
                result
            };
            if step == 1 {
                assert_eq!(result["result"], "Accepted");
                assert_eq!(result["outcome"], "Completed");
                assert_eq!(result["completion"]["output"], "737461747573");
                assert!(!result.to_string().contains(":null"));
            } else {
                assert_eq!(
                    result,
                    serde_json::json!(if step == 2 { "NotStarted" } else { "Accepted" }),
                    "{name}, desktop={desktop}"
                );
            }
            assert_session_effects(&state, &session, step);
        }
        drop(session._keep_alive);
        state.pty.force_kill(&session.id).await.unwrap();
    }
    super::command_editor::teardown(&ctx.client_id);
}

#[test]
fn desktop_invoke_handler_registers_session_rpcs() {
    let source = include_str!("../../lib.rs");
    let (_, handler) = source
        .split_once("generate_handler![")
        .expect("desktop invoke handler");
    let (handler, _) = handler.split_once(']').expect("handler closing bracket");
    for command in [
        "commands::command_editor_submit",
        "commands::command_editor_request_completion",
        "commands::command_editor_cancel_completion",
        "commands::command_editor_restore_prompt",
    ] {
        assert!(
            handler.split(',').any(|entry| entry.trim() == command),
            "missing desktop registration: {command}"
        );
    }
}

fn completion_request(id: &str) -> super::Request {
    super::Request {
        id: "completion".into(),
        type_: super::command_editor::REQUEST_COMPLETION.into(),
        payload: session_requests(id)[1].1.clone(),
        command_id: None,
    }
}

fn completion_from_trigger(
    bytes: &Arc<Mutex<Vec<u8>>>,
) -> crate::pty::session_protocol::frame::CompletionResult {
    let bytes = bytes.lock().unwrap();
    let text = String::from_utf8_lossy(&bytes);
    let request_id = text
        .split("GEN-ONE ")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap();
    crate::pty::session_protocol::frame::CompletionResult {
        session_id: "s1".into(),
        nonce: "n1".into(),
        request_id: request_id.into(),
        buffer_revision: 1,
        cursor: 7,
        prompt_generation: 1,
        cwd: "/tmp".into(),
        output: "737461747573".into(),
    }
}

async fn next_socket_reply(peer: &mut crate::web::ws::harness::carrier::Peer) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let frame = peer.next_frame().await.expect("socket ended before reply");
            if let axum::extract::ws::Message::Text(text) = frame {
                let reply: serde_json::Value = serde_json::from_str(&text).unwrap();
                if reply.get("id").is_some() {
                    return reply;
                }
            }
        }
    })
    .await
    .expect("socket reply timed out")
}

async fn session_socket(
    state: &super::AppState,
    session: &AdoptedSession,
    device: &str,
) -> (
    crate::web::ws::harness::carrier::Peer,
    tokio::task::JoinHandle<()>,
) {
    let (carrier, mut peer) = crate::web::ws::harness::carrier::pair();
    let task = tokio::spawn(super::serve_socket(
        state.connections.shutdown.admit(),
        carrier,
        state.clone(),
        std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
    ));
    peer.send_json(&serde_json::json!({"id":"auth", "type":"authenticate", "payload":{
        "protocolVersion":crate::web::ws::WS_PROTOCOL_VERSION, "deviceId":device, "clientInstanceId":"tab-1"}}));
    assert_eq!(next_socket_reply(&mut peer).await["success"], true);
    peer.send_json(
        &serde_json::json!({"id":"attach", "type":"attach", "payload":{
        "terminalId":session.id, "claim":session.claim, "lastSeq":0}}),
    );
    assert_eq!(next_socket_reply(&mut peer).await["success"], true);
    (peer, task)
}

async fn await_generator(state: &super::AppState, id: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !state.pty.get(id).unwrap().session_gate.generator_active() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("generator was not admitted");
}

#[tokio::test]
async fn submit_refuses_control_bytes_before_any_pty_write() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let (mut peer, task) = session_socket(&state, &session, "ctrl").await;
    peer.send_json(&serde_json::json!({
        "id": "submit",
        "type": super::command_editor::SUBMIT,
        "payload": {
            "terminalId": session.id,
            "draft": "safe\u{1b}[201~\recho injected",
        },
    }));
    let reply = next_socket_reply(&mut peer).await;
    assert_eq!(reply["data"], "PreWrite");
    assert!(
        session.bytes.lock().unwrap().is_empty(),
        "PreWrite must not write any PTY byte: {:?}",
        String::from_utf8_lossy(&session.bytes.lock().unwrap())
    );
    assert!(
        state
            .pty
            .get(&session.id)
            .unwrap()
            .session_gate
            .trusted_at_prompt(),
        "a pre-write refusal keeps the trusted prompt"
    );
    drop(peer);
    task.await.unwrap();
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn only_the_owner_cancels_its_completion() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let (mut a, a_task) = session_socket(&state, &session, "A").await;
    let (mut b, b_task) = session_socket(&state, &session, "B").await;
    a.send_json(
        &serde_json::json!({"id":"completion", "type":super::command_editor::REQUEST_COMPLETION,
        "payload":completion_request(&session.id).payload}),
    );
    await_generator(&state, &session.id).await;
    b.send_json(
        &serde_json::json!({"id":"cancel", "type":super::command_editor::CANCEL_COMPLETION,
        "payload":{"terminalId":session.id, "requestId":"r1"}}),
    );
    let reply = next_socket_reply(&mut b).await;
    assert_eq!(
        reply["data"], "NotStarted",
        "connection B must not cancel A's completion"
    );
    state
        .pty
        .get(&session.id)
        .unwrap()
        .session_gate
        .finish_completion(completion_from_trigger(&session.bytes));
    let reply = next_socket_reply(&mut a).await;
    assert_eq!(reply["data"]["outcome"], "Completed");
    assert_eq!(reply["data"]["completion"]["request_id"], "r1");
    drop(a);
    drop(b);
    a_task.await.unwrap();
    b_task.await.unwrap();
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn slow_completion_does_not_block_the_socket() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let gate = state.pty.get(&session.id).unwrap().session_gate.clone();
    let (mut peer, task) = session_socket(&state, &session, "serial").await;
    peer.send_json(
        &serde_json::json!({"id":"completion", "type":super::command_editor::REQUEST_COMPLETION,
        "payload":completion_request(&session.id).payload}),
    );
    await_generator(&state, &session.id).await;
    for (id, name, payload) in [
        (
            "cancel",
            super::command_editor::CANCEL_COMPLETION,
            session_requests(&session.id)[2].1.clone(),
        ),
        (
            "submit",
            super::command_editor::SUBMIT,
            session_requests(&session.id)[0].1.clone(),
        ),
    ] {
        peer.send_json(&serde_json::json!({"id":id, "type":name, "payload":payload}));
    }
    let reply = next_socket_reply(&mut peer).await;
    assert_eq!(
        reply["id"], "cancel",
        "cancel reply must arrive before the completion reply"
    );
    assert_eq!(reply["data"], "Accepted");
    assert!(
        gate.suppressing_output(),
        "cancel must retain the generator drain"
    );
    gate.finish_completion(completion_from_trigger(&session.bytes));
    let mut outcomes = Vec::new();
    for _ in 0..2 {
        let reply = next_socket_reply(&mut peer).await;
        if reply["id"] == "completion" {
            assert_eq!(reply["data"]["outcome"], "Cancelled");
            assert!(reply["data"].get("completion").is_none());
            outcomes.push(reply["id"].clone());
        } else {
            assert_eq!(reply["id"], "submit");
            assert_eq!(reply["data"], "Accepted");
        }
    }
    assert_eq!(outcomes.len(), 1, "exactly one completion reply");
    assert!(
        session.bytes.lock().unwrap().ends_with(
            format!(
                "{}\x1b[200~git sta\x1b[201~\r",
                crate::pty::session_protocol::CLEAR_LINE_SEQUENCE
            )
            .as_bytes()
        ),
        "submit follows the drained generator"
    );
    gate.mark_trusted_prompt(1, "/tmp".into());
    peer.send_json(
        &serde_json::json!({"id":"pending-close", "type":super::command_editor::REQUEST_COMPLETION,
        "payload":completion_request(&session.id).payload}),
    );
    await_generator(&state, &session.id).await;
    drop(peer);
    // A detached wait retains the outbound sender and keeps run() alive until its timeout.
    tokio::time::timeout(std::time::Duration::from_millis(200), task)
        .await
        .expect("socket teardown did not abort its completion wait")
        .unwrap();
    assert!(
        gate.suppressing_output(),
        "the host watchdog remains independent of socket teardown"
    );
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn desktop_cancel_reply_omits_completion() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let webview = desktop_session_webview(&state);
    let requests = session_requests(&session.id);
    let (reply, cancelled) = tokio::join!(
        desktop_session_invoke(&webview, requests[1].0, &requests[1].1),
        async {
            await_generator(&state, &session.id).await;
            desktop_session_invoke(&webview, requests[2].0, &requests[2].1).await
        }
    );
    assert_eq!(cancelled, "Accepted");
    assert_eq!(reply["result"], "Accepted");
    assert_eq!(reply["outcome"], "Cancelled");
    assert!(reply.get("completion").is_none());
    assert!(!reply.to_string().contains(":null"));
    let gate = state.pty.get(&session.id).unwrap().session_gate.clone();
    assert!(gate.suppressing_output());
    gate.finish_completion(completion_from_trigger(&session.bytes));
    state.pty.force_kill(&session.id).await.unwrap();
}

async fn frames_until_reply(
    peer: &mut crate::web::ws::harness::carrier::Peer,
    id: &str,
) -> Vec<serde_json::Value> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut frames = Vec::new();
        loop {
            let frame = peer.next_frame().await.expect("socket ended");
            let axum::extract::ws::Message::Text(text) = frame else {
                continue;
            };
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            let done = value.get("id").and_then(|v| v.as_str()) == Some(id);
            frames.push(value);
            if done {
                return frames;
            }
        }
    })
    .await
    .expect("frames until reply timed out")
}

fn lifecycle_after_replay(frames: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let replay = frames
        .iter()
        .position(|frame| frame["type"] == "replay")
        .expect("attach must send replay");
    frames[replay + 1..]
        .iter()
        .filter(|frame| frame.get("id").is_none() && frame["type"] == "event")
        .cloned()
        .collect()
}

async fn attach_lifecycle(
    state: &super::AppState,
    session: &AdoptedSession,
) -> (
    Vec<serde_json::Value>,
    crate::web::ws::harness::carrier::Peer,
    tokio::task::JoinHandle<()>,
) {
    let (carrier, mut peer) = crate::web::ws::harness::carrier::pair();
    let task = tokio::spawn(super::serve_socket(
        state.connections.shutdown.admit(),
        carrier,
        state.clone(),
        std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
    ));
    peer.send_json(&serde_json::json!({"id":"auth", "type":"authenticate", "payload":{
        "protocolVersion":crate::web::ws::WS_PROTOCOL_VERSION, "deviceId":"late", "clientInstanceId":"tab-1"}}));
    assert_eq!(next_socket_reply(&mut peer).await["success"], true);
    peer.send_json(
        &serde_json::json!({"id":"attach", "type":"attach", "payload":{
        "terminalId":session.id, "claim":session.claim, "lastSeq":0}}),
    );
    let frames = frames_until_reply(&mut peer, "attach").await;
    (lifecycle_after_replay(&frames), peer, task)
}

fn assert_lifecycle_kind(event: &serde_json::Value, kind: &str) {
    assert_eq!(event["type"], "event");
    let payload = &event["payload"];
    assert_eq!(payload["type"], "session_lifecycle");
    assert_eq!(payload["kind"], kind);
    assert_eq!(payload["session_id"], "s1");
    assert_eq!(payload["nonce"], "n1");
    assert!(payload.get("draft").is_none());
    assert!(payload.get("completion").is_none());
}

#[tokio::test]
async fn late_attach_receives_the_registered_prompt() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let (events, peer, task) = attach_lifecycle(&state, &session).await;
    assert_eq!(events.len(), 2, "InitShell then PromptReady: {events:?}");
    assert_lifecycle_kind(&events[0], "InitShell");
    assert_lifecycle_kind(&events[1], "PromptReady");
    assert_eq!(events[1]["payload"]["prompt_generation"], 1);
    assert_eq!(events[1]["payload"]["cwd"], "/tmp");
    assert_eq!(events[1]["payload"]["line_empty"], true);
    assert_eq!(events[1]["payload"]["prompt_suppressed"], true);
    drop(peer);
    let _ = task.await;
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn late_attach_while_executing_gets_only_init() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    state.pty.get(&session.id).unwrap().session_gate.mark_raw();
    let (events, peer, task) = attach_lifecycle(&state, &session).await;
    assert_eq!(
        events.len(),
        2,
        "InitShell then Desync after mark_raw: {events:?}"
    );
    assert_lifecycle_kind(&events[0], "InitShell");
    assert_lifecycle_kind(&events[1], "Desync");
    drop(peer);
    let _ = task.await;
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn late_attach_without_handshake_gets_nothing() {
    let state = super::tests::gate_test_state(None);
    let (reader, keep_alive) = std::io::pipe().unwrap();
    let spawned = state
        .pty
        .adopt_external(crate::pty::manager::ExternalTerminal {
            reader: Box::new(reader),
            writer: Box::new(SharedWriter(std::sync::Arc::new(std::sync::Mutex::new(
                Vec::new(),
            )))),
            child: Box::new(RunningChild::default()),
            resizer: std::sync::Arc::new(|_, _| Ok(())),
            shell: "test".into(),
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
        })
        .await
        .unwrap();
    let raw = AdoptedSession {
        id: spawned.info.id,
        claim: spawned.claim,
        bytes: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        _keep_alive: keep_alive,
    };
    let (events, peer, task) = attach_lifecycle(&state, &raw).await;
    assert!(
        events.is_empty(),
        "unregistered attach must send no lifecycle: {events:?}"
    );
    drop(peer);
    let _ = task.await;
    state.pty.force_kill(&raw.id).await.unwrap();
}

fn lifecycle_event(
    terminal_id: &str,
    kind: &str,
) -> crate::trackers::terminal_events::TerminalEvent {
    crate::trackers::terminal_events::TerminalEvent::SessionLifecycle {
        lifecycle_sequence: None,
        terminal_id: terminal_id.to_owned(),
        session_id: "s1".to_owned(),
        kind: kind.to_owned(),
        nonce: Some("n1".to_owned()),
        prompt_suppressed: false,
        line_empty: false,
        exit_code: None,
        prompt_generation: None,
        cwd: None,
    }
}

fn event_kinds(frames: &[serde_json::Value]) -> Vec<String> {
    frames
        .iter()
        .filter(|frame| frame["type"] == "event")
        .filter_map(|frame| frame["payload"]["kind"].as_str().map(str::to_owned))
        .collect()
}

async fn attach_window_with_lifecycle(kind: &str) -> (Vec<serde_json::Value>, String) {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let event_task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        state.terminal_events.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    let _attaching = ctx.begin_attach(&session.id);
    let gate = state.pty.get(&session.id).unwrap().session_gate.clone();
    let _snapshot = gate.authentic_session();
    state
        .terminal_events
        .emit(lifecycle_event(&session.id, kind));
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let sequence =
        super::command_editor::send_authentic_session(&tx, gate.authentic_session(), &session.id)
            .await
            .expect("replayed session");
    ctx.finish_attach(&tx, &session.id, sequence)
        .await
        .expect("flush attach");
    drop(tx);
    event_task.abort();
    let mut frames = Vec::new();
    while let Some(message) = rx.recv().await {
        let axum::extract::ws::Message::Text(text) = message else {
            continue;
        };
        frames.push(serde_json::from_str(&text).unwrap());
    }
    let id = session.id.clone();
    state.pty.force_kill(&session.id).await.unwrap();
    (frames, id)
}

#[tokio::test]
async fn desync_during_attach_arrives_after_replayed_prompt() {
    let (frames, _) = attach_window_with_lifecycle("Desync").await;
    let kinds = event_kinds(&frames);
    assert_eq!(
        kinds,
        ["InitShell", "PromptReady", "Desync"],
        "Desync after the gate snapshot follows InitShell+PromptReady: {frames:?}"
    );
}

#[tokio::test]
async fn lifecycle_during_attach_is_not_lost() {
    let (frames, _) = attach_window_with_lifecycle("CommandStarted").await;
    let kinds = event_kinds(&frames);
    assert!(
        kinds.iter().any(|kind| kind == "CommandStarted"),
        "lifecycle during attach must be flushed, not dropped: {kinds:?}"
    );
    let init = kinds
        .iter()
        .position(|kind| kind == "InitShell")
        .expect("InitShell");
    let started = kinds
        .iter()
        .position(|kind| kind == "CommandStarted")
        .expect("CommandStarted");
    assert!(
        init < started,
        "CommandStarted after replayed InitShell: {kinds:?}"
    );
}

#[test]
fn attach_marks_attaching_before_replayed_session() {
    let source = include_str!("../terminal_ws.rs");
    let attach = source.split("\"attach\" =>").nth(1).expect("attach arm");
    let begin = attach.find("begin_attach").expect("begin_attach in attach");
    let authentic = attach
        .find("send_authentic_session")
        .expect("send_authentic_session in attach");
    let finish = attach
        .find("finish_attach")
        .expect("finish_attach in attach");
    assert!(
        begin < authentic,
        "attaching must start before replayed session"
    );
    assert!(
        authentic < finish,
        "buffered lifecycle must flush after replayed session"
    );
}

async fn buffered_snapshot_case(executing: bool) -> Vec<serde_json::Value> {
    let mut ctx = super::tests::gate_test_ctx(true);
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let gate = Arc::new(SessionGate::new(Arc::new(AsyncMutex::new(None))));
    gate.expect_session("s1".into(), "n1".into());
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    let task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        hub.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    let _attaching = ctx.begin_attach("test");
    let pending = Mutex::new(Vec::new());
    let mut filter = crate::pty::session_protocol::filter::SessionFilter::new();
    let mut frames = vec![
        serde_json::json!({"type":"InitShell","session_id":"s1","nonce":"n1"}),
        serde_json::json!({"type":"PromptReady","nonce":"n1","prompt_generation":1,"cwd":"/tmp","line_empty":true,"prompt_suppressed":true}),
    ];
    frames.push(serde_json::json!({"type":"PromptReady","nonce":"n1","prompt_generation":2,"cwd":"/tmp","line_empty":true,"prompt_suppressed":true}));
    if executing {
        frames.push(serde_json::json!({"type":"CommandStarted","nonce":"n1"}));
    }
    for frame in frames {
        let bytes = format!("\x1b]9477;{frame}\x07");
        assert!(crate::pty::session_protocol::deliver::process_reader_chunk(
            &mut filter,
            bytes.as_bytes(),
            &pending,
            &gate,
            "test",
            &hub,
        ));
        if !executing && frame["type"] == "InitShell" {
            let mut invalid = b"\x1b]9477;".to_vec();
            invalid
                .extend(vec![b'x'; crate::pty::session_protocol::filter::MAX_SESSION_FRAME_BYTES]);
            invalid.push(7);
            crate::pty::session_protocol::deliver::process_reader_chunk(
                &mut filter,
                &invalid,
                &pending,
                &gate,
                "test",
                &hub,
            );
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let sequence =
        super::command_editor::send_authentic_session(&tx, gate.authentic_session(), "test")
            .await
            .unwrap();
    ctx.finish_attach(&tx, "test", sequence).await.unwrap();
    task.abort();
    let _ = task.await;
    drop(tx);
    let mut result = Vec::new();
    while let Some(axum::extract::ws::Message::Text(text)) = rx.recv().await {
        result.push(serde_json::from_str(&text).unwrap());
    }
    result
}

#[tokio::test]
async fn stale_desync_before_snapshot_is_dropped() {
    let frames = buffered_snapshot_case(false).await;
    assert_eq!(event_kinds(&frames), ["InitShell", "PromptReady"]);
    assert_eq!(frames[1]["payload"]["prompt_generation"], 2);
}

#[tokio::test]
async fn stale_prompt_before_executing_snapshot_is_dropped() {
    let frames = buffered_snapshot_case(true).await;
    assert_eq!(event_kinds(&frames), ["InitShell", "CommandStarted"]);
}

#[tokio::test]
async fn exit_during_attach_is_not_revived() {
    for exit_before_snapshot in [false, true] {
        let gate = SessionGate::new(Arc::new(AsyncMutex::new(None)));
        gate.expect_session("s1".into(), "n1".into());
        assert!(gate.register_session("s1".into(), "n1".into()));
        let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
        let mut ctx = super::tests::gate_test_ctx(true);
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let events = hub.subscribe();
        let _pending = ctx.begin_attach("test");
        let mut sequence = 0;
        if !exit_before_snapshot {
            sequence = super::command_editor::send_authentic_session(
                &tx,
                gate.authentic_session(),
                "test",
            )
            .await
            .unwrap();
        }
        gate.publish_exit(&hub, || {
            gate.process_exited();
            crate::trackers::terminal_events::TerminalEvent::Exit {
                terminal_id: "test".into(),
                exit_code: Some(0),
                signal: None,
                lifecycle_sequence: None,
            }
        });
        if exit_before_snapshot {
            sequence = super::command_editor::send_authentic_session(
                &tx,
                gate.authentic_session(),
                "test",
            )
            .await
            .unwrap();
            assert!(
                rx.try_recv().is_err(),
                "exited snapshot must not replay InitShell"
            );
        }
        // Deliberately start the receiver after finish: queued events must obey S too.
        ctx.finish_attach(&tx, "test", sequence).await.unwrap();
        let task = super::command_editor::spawn_event_forwarder(
            tx.clone(),
            events,
            ctx.authorized.clone(),
            ctx.attaching.clone(),
        );
        hub.emit(
            crate::trackers::terminal_events::TerminalEvent::CwdChanged {
                terminal_id: "test".into(),
                cwd: "/sentinel".into(),
            },
        );
        let mut kinds = Vec::new();
        while let Some(axum::extract::ws::Message::Text(text)) = rx.recv().await {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            let payload = &value["payload"];
            if payload["type"] == "cwd_changed" {
                break;
            }
            kinds.push(payload["kind"].as_str().unwrap_or("Exit").to_owned());
        }
        assert_eq!(
            kinds,
            if exit_before_snapshot {
                vec![]
            } else {
                vec!["InitShell", "Exit"]
            }
        );
        task.abort();
    }
}

#[tokio::test]
async fn attach_send_failure_clears_attaching() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    let request = super::Request {
        id: "attach-failure".into(),
        type_: "attach".into(),
        command_id: None,
        payload: serde_json::json!({"terminalId":session.id,"claim":session.claim}),
    };
    let result = super::handle(request, &state, &tx, &mut ctx).await;
    assert!(result.is_err());
    assert!(
        ctx.attaching.read().buffers.is_empty(),
        "failed attach must remove its buffer"
    );
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn attach_buffer_overflow_fails_cleanly() {
    let mut ctx = super::tests::gate_test_ctx(true);
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let (tx, _rx) = tokio::sync::mpsc::channel(1024);
    let task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        hub.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    let _attaching = ctx.begin_attach("test");
    for sequence in 1..=300 {
        let mut event = lifecycle_event("test", "Desync");
        event.set_lifecycle_sequence(sequence);
        hub.emit(event);
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let result = ctx.finish_attach(&tx, "test", 0).await;
    assert!(
        result.is_err(),
        "overflow must fail attach instead of growing"
    );
    assert!(ctx.attaching.read().buffers.is_empty());
    task.abort();
}

#[tokio::test]
async fn forwarder_stops_when_outbound_closed() {
    let ctx = super::tests::gate_test_ctx(true);
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let task = super::command_editor::spawn_event_forwarder(
        tx,
        hub.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    drop(rx);
    let result = tokio::time::timeout(std::time::Duration::from_millis(100), task).await;
    assert!(
        result.is_ok(),
        "forwarder must stop without waiting for another hub event"
    );
}

#[tokio::test]
async fn desync_after_snapshot_is_delivered_after_replay() {
    let gate = Arc::new(SessionGate::new(Arc::new(AsyncMutex::new(None))));
    gate.expect_session("s1".into(), "n1".into());
    assert!(gate.register_session("s1".into(), "n1".into()));
    gate.mark_trusted_prompt(2, "/tmp".into());
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        hub.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    let _pending = ctx.begin_attach("test");
    let sequence =
        super::command_editor::send_authentic_session(&tx, gate.authentic_session(), "test")
            .await
            .unwrap();
    let mut invalid = b"\x1b]9477;".to_vec();
    invalid.extend(vec![b'x'; crate::pty::session_protocol::filter::MAX_SESSION_FRAME_BYTES]);
    invalid.push(7);
    crate::pty::session_protocol::deliver::process_reader_chunk(
        &mut crate::pty::session_protocol::filter::SessionFilter::new(),
        &invalid,
        &Mutex::new(Vec::new()),
        &gate,
        "test",
        &hub,
    );
    ctx.finish_attach(&tx, "test", sequence).await.unwrap();
    let mut frames = Vec::new();
    for _ in 0..3 {
        let message = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let axum::extract::ws::Message::Text(text) = message else {
            panic!("text event")
        };
        frames.push(serde_json::from_str(&text).unwrap());
    }
    assert_eq!(event_kinds(&frames), ["InitShell", "PromptReady", "Desync"]);
    task.abort();
}

#[test]
fn lifecycle_sequence_is_not_serialized() {
    let mut lifecycle = lifecycle_event("test", "Desync");
    lifecycle.set_lifecycle_sequence(42);
    let exit = crate::trackers::terminal_events::TerminalEvent::Exit {
        terminal_id: "test".into(),
        exit_code: Some(3),
        signal: None,
        lifecycle_sequence: Some(43),
    };
    let value = serde_json::to_value(lifecycle).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "type":"session_lifecycle","terminal_id":"test","session_id":"s1",
            "kind":"Desync","nonce":"n1","prompt_suppressed":false,"line_empty":false,
            "exit_code":null,"prompt_generation":null,"cwd":null,
        })
    );
    assert_eq!(
        serde_json::to_value(exit).unwrap(),
        serde_json::json!({
            "type":"exit","terminal_id":"test","exit_code":3,"signal":null,
        })
    );
}

#[tokio::test]
async fn serve_request_stops_when_reply_or_error_send_fails() {
    let state = super::tests::gate_test_state(None);
    for op in ["unknown-operation", "list"] {
        let mut ctx = super::tests::gate_test_ctx(true);
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        drop(rx);
        let request = super::Request {
            id: op.into(),
            type_: op.into(),
            command_id: None,
            payload: serde_json::json!({}),
        };
        let stop = tokio_util::sync::CancellationToken::new();
        assert!(
            super::command_editor::serve_request(request, &state, &tx, &mut ctx, &stop)
                .await
                .is_none()
        );
        super::command_editor::teardown(&ctx.client_id);
    }
}

#[tokio::test]
async fn cancelled_attach_clears_attaching() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let request = super::Request {
        id: "cancelled-attach".into(),
        type_: "attach".into(),
        command_id: None,
        payload: serde_json::json!({"terminalId":session.id,"claim":session.claim}),
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(30),
        super::handle(request, &state, &tx, &mut ctx),
    )
    .await;
    assert!(result.is_err(), "full outbound channel must suspend replay");
    assert!(
        ctx.attaching.read().buffers.is_empty(),
        "cancelled replay must release its buffer"
    );
    state.pty.force_kill(&session.id).await.unwrap();
}

#[tokio::test]
async fn exit_while_replay_send_is_blocked_reaches_the_client() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let gate = state.pty.get(&session.id).unwrap().session_gate.clone();
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let event_task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        state.terminal_events.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    tx.send(axum::extract::ws::Message::Text("blocked".into()))
        .await
        .unwrap();
    let request = super::Request {
        id: "exit-at-replay".into(),
        type_: "attach".into(),
        command_id: None,
        payload: serde_json::json!({"terminalId":session.id,"claim":session.claim}),
    };
    let mut frames = Vec::<serde_json::Value>::new();
    {
        let attaching = super::handle(request, &state, &tx, &mut ctx);
        tokio::pin!(attaching);
        tokio::select! { biased;
            result = &mut attaching => panic!("replay should be blocked: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        gate.publish_exit(&state.terminal_events, || {
            gate.process_exited();
            crate::trackers::terminal_events::TerminalEvent::Exit {
                terminal_id: session.id.clone(),
                exit_code: Some(0),
                signal: None,
                lifecycle_sequence: None,
            }
        });
        rx.recv().await.unwrap();
        let collect = async {
            while let Ok(Some(axum::extract::ws::Message::Text(text))) =
                tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await
            {
                frames.push(serde_json::from_str(&text).unwrap());
            }
        };
        let (result, ()) = tokio::join!(attaching, collect);
        result.unwrap();
    }
    assert_eq!(frames[0]["snapshot"]["exited"], false);
    assert!(
        frames
            .iter()
            .any(|frame| frame["payload"]["type"] == "exit"),
        "Exit after the replay snapshot must reach the client: {frames:?}"
    );
    event_task.abort();
    ctx.release_all(&state);
    state.pty.force_kill(&session.id).await.unwrap();
}

fn registered_replay_gate() -> (Arc<Mutex<Vec<u8>>>, Arc<SessionGate>) {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer: Box<dyn Write + Send> = Box::new(SharedWriter(bytes.clone()));
    let gate = SessionGate::new(Arc::new(AsyncMutex::new(Some(writer))));
    gate.expect_session("s1".into(), "n1".into());
    assert!(gate.register_session("s1".into(), "n1".into()));
    (bytes, Arc::new(gate))
}

async fn replay_kinds(gate: &SessionGate) -> Vec<String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    super::command_editor::send_authentic_session(&tx, gate.authentic_session(), "test")
        .await
        .unwrap();
    drop(tx);
    let mut frames = Vec::new();
    while let Some(axum::extract::ws::Message::Text(text)) = rx.recv().await {
        frames.push(serde_json::from_str(&text).unwrap());
    }
    event_kinds(&frames)
}

fn deliver_lifecycle(gate: &Arc<SessionGate>, frame: serde_json::Value) {
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let pending = Mutex::new(Vec::new());
    let mut filter = crate::pty::session_protocol::filter::SessionFilter::new();
    let bytes = format!("\x1b]9477;{frame}\x07");
    assert!(crate::pty::session_protocol::deliver::process_reader_chunk(
        &mut filter,
        bytes.as_bytes(),
        &pending,
        gate,
        "test",
        &hub,
    ));
}

#[tokio::test]
async fn replay_after_command_started_is_init_then_started() {
    let (bytes, gate) = registered_replay_gate();
    gate.mark_trusted_prompt(1, "/tmp".into());
    deliver_lifecycle(
        &gate,
        serde_json::json!({"type":"CommandStarted","nonce":"n1"}),
    );
    assert_eq!(replay_kinds(&gate).await, ["InitShell", "CommandStarted"]);
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "replaying must not write the PTY"
    );
}

#[tokio::test]
async fn replay_after_mark_raw_is_init_then_desync() {
    let (bytes, gate) = registered_replay_gate();
    gate.mark_trusted_prompt(1, "/tmp".into());
    gate.mark_raw();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    super::command_editor::send_authentic_session(&tx, gate.authentic_session(), "test")
        .await
        .unwrap();
    drop(tx);
    let mut frames = Vec::new();
    while let Some(axum::extract::ws::Message::Text(text)) = rx.recv().await {
        frames.push(serde_json::from_str(&text).unwrap());
    }
    assert_eq!(event_kinds(&frames), ["InitShell", "Desync"]);
    assert_eq!(
        frames[1]["payload"],
        serde_json::json!({
            "type":"session_lifecycle","terminal_id":"test","session_id":"s1",
            "kind":"Desync","nonce":"n1","prompt_suppressed":false,"line_empty":false,
            "exit_code":null,"prompt_generation":null,"cwd":null,
        })
    );
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "replaying must not write a restore"
    );
}

#[tokio::test]
async fn replay_after_trusted_prompt_is_init_then_prompt() {
    let (bytes, gate) = registered_replay_gate();
    gate.mark_raw();
    gate.mark_trusted_prompt(4, "/repo".into());
    assert_eq!(replay_kinds(&gate).await, ["InitShell", "PromptReady"]);
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "replaying must not write the PTY"
    );
}

#[test]
fn detach_clears_attach_watermarks_and_overflow() {
    let mut ctx = super::tests::gate_test_ctx(true);
    ctx.authorize("t1");
    {
        let mut attaching = ctx.attaching.write();
        attaching.buffers.insert("t1".into(), Vec::new());
        attaching.watermarks.insert("t1".into(), 9);
        attaching.overflowed.insert("t1".into());
    }
    let state = super::tests::gate_test_state(None);
    ctx.detach("t1", &state);
    let attaching = ctx.attaching.read();
    assert!(!attaching.buffers.contains_key("t1"));
    assert!(!attaching.watermarks.contains_key("t1"));
    assert!(!attaching.overflowed.contains("t1"));
}

#[tokio::test]
async fn attach_overflow_unauthorizes_and_drops_later_hub_events() {
    let mut ctx = super::tests::gate_test_ctx(true);
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let task = super::command_editor::spawn_event_forwarder(
        tx.clone(),
        hub.subscribe(),
        ctx.authorized.clone(),
        ctx.attaching.clone(),
    );
    let _attaching = ctx.begin_attach("test");
    for sequence in 1..=300 {
        let mut event = lifecycle_event("test", "Desync");
        event.set_lifecycle_sequence(sequence);
        hub.emit(event);
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let result = ctx.finish_attach(&tx, "test", 0).await;
    assert!(
        result.is_err(),
        "overflow must fail attach instead of growing"
    );
    assert!(
        !ctx.is_authorized("test"),
        "overflow must drop authorization"
    );
    hub.emit(lifecycle_event("test", "PromptReady"));
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    drop(tx);
    task.abort();
    let mut kinds = Vec::new();
    while let Some(axum::extract::ws::Message::Text(text)) = rx.recv().await {
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        if let Some(kind) = value["payload"]["kind"].as_str() {
            kinds.push(kind.to_owned());
        }
    }
    assert!(
        !kinds.iter().any(|kind| kind == "PromptReady"),
        "later hub events must not be forwarded after overflow: {kinds:?}"
    );
}

fn kinds(snapshot: AuthenticSession) -> Vec<String> {
    authentic_session_events(snapshot, "test")
        .into_iter()
        .map(|event| {
            serde_json::to_value(event).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

#[test]
fn replay_at_prompt_without_trust_desyncs() {
    let (_, gate) = registered_replay_gate();
    gate.mark_trusted_prompt(1, "/tmp".into());
    let mut snapshot = gate.authentic_session();
    snapshot.prompt = None;
    assert_eq!(kinds(snapshot), ["InitShell", "Desync"]);
}

fn cleanup_forwarder(
    ctx: &ConnectionContext,
    tx: &mpsc::Sender<Message>,
    id: &str,
) -> Box<dyn FnOnce() + Send + Sync> {
    let authorized = ctx.authorized.clone();
    let attaching = ctx.attaching.clone();
    let tx = tx.clone();
    let id = id.to_owned();
    Box::new(move || {
        // Run exactly after the overflow state becomes invisible.
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(forward_or_buffer_hub_event(
                    &lifecycle_event(&id, "PromptReady"),
                    &authorized,
                    &attaching,
                    &tx,
                ))
        })
        .join()
        .unwrap()
        .unwrap();
    })
}

#[tokio::test]
async fn overflow_cleanup_blocks_interleaved_forwarding_and_allows_reattach() {
    let state = super::tests::gate_test_state(None);
    let session = adopt_session(&state).await;
    let mut ctx = super::tests::gate_test_ctx(true);
    let (tx, mut rx) = mpsc::channel(8);
    let pending = ctx.begin_attach(&session.id);
    let hook = cleanup_forwarder(&ctx, &tx, &session.id);
    {
        let mut attaching = ctx.attaching.write();
        attaching.overflowed.insert(session.id.clone());
        attaching.cleanup_hook = Some(hook);
    }
    assert!(ctx.finish_attach(&tx, &session.id, 0).await.is_err());
    assert!(
        rx.try_recv().is_err(),
        "overflow cleanup forwarded a lifecycle event"
    );
    drop(pending);
    let request = Request {
        id: "reattach".into(),
        type_: "attach".into(),
        command_id: None,
        payload: json!({"terminalId":session.id, "claim":session.claim}),
    };
    super::handle(request, &state, &tx, &mut ctx).await.unwrap();
    while rx.try_recv().is_ok() {}
    forward_or_buffer_hub_event(
        &lifecycle_event(&session.id, "PromptReady"),
        &ctx.authorized,
        &ctx.attaching,
        &tx,
    )
    .await
    .unwrap();
    assert!(
        rx.try_recv().is_ok(),
        "re-attach with the same claim must resume forwarding"
    );
    ctx.release_all(&state);
    state.pty.force_kill(&session.id).await.unwrap();
}

struct CompletionFailWriter(bool);

impl std::io::Write for CompletionFailWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0 {
            Ok(bytes.len())
        } else {
            Err(std::io::Error::other("write failed"))
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if self.0 {
            Err(std::io::Error::other("flush failed"))
        } else {
            Ok(())
        }
    }
}

fn completion_gate_request() -> CompletionRequest {
    CompletionRequest {
        request_id: "r1".into(),
        buffer_revision: 1,
        cursor: 7,
        draft: "git sta".into(),
        prompt_generation: 1,
        cwd: "/tmp".into(),
    }
}

#[tokio::test]
async fn partial_completion_write_replays_desync() {
    partial_completion_replay(false).await;
}

#[tokio::test]
async fn partial_completion_flush_replays_desync() {
    partial_completion_replay(true).await;
}

async fn partial_completion_replay(fail_on_flush: bool) {
    use crate::pty::session_protocol::{
        frame::SessionRpcResult,
        gate::{CompletionProvider, SessionGate},
    };
    let writer: Box<dyn std::io::Write + Send> = Box::new(CompletionFailWriter(fail_on_flush));
    let gate = SessionGate::new(Arc::new(tokio::sync::Mutex::new(Some(writer))));
    gate.expect_session("s1".into(), "n1".into());
    assert!(gate.register_session("s1".into(), "n1".into()));
    gate.mark_trusted_prompt(1, "/tmp".into());
    let provider = CompletionProvider {
        id: "gen".into(),
        command: b"GEN-ONE".to_vec(),
        restorable: true,
    };
    assert_eq!(
        gate.request_completion(&completion_gate_request(), &provider, true)
            .await
            .result,
        SessionRpcResult::Partial
    );
    let snapshot = gate.authentic_session();
    let phase = snapshot.phase;
    assert_eq!(kinds(snapshot), ["InitShell", "Desync"]);
    assert_eq!(phase, SessionPhase::Raw);
}

#[tokio::test(start_paused = true)]
async fn completion_failures_replay_desync() {
    use crate::pty::session_protocol::{frame::CompletionResult, rpc};
    for watchdog in [false, true] {
        let state = super::tests::gate_test_state(None);
        let session = adopt_session(&state).await;
        let gate = state.pty.get(&session.id).unwrap().session_gate.clone();
        let start =
            rpc::admit_completion(&state.pty, &session.id, &completion_gate_request(), true).await;
        assert_eq!(
            start.result,
            crate::pty::session_protocol::frame::SessionRpcResult::Accepted
        );
        if watchdog {
            // Awaiting the waiter advances paused time through both host deadlines.
            rpc::wait_for_completion(start).await;
        } else {
            gate.finish_completion(CompletionResult {
                session_id: "s1".into(),
                nonce: "n1".into(),
                request_id: "r1".into(),
                buffer_revision: 1,
                cursor: 7,
                prompt_generation: 2,
                cwd: "/tmp".into(),
                output: String::new(),
            });
        }
        let snapshot = gate.authentic_session();
        assert_eq!(snapshot.phase, SessionPhase::Raw);
        assert_eq!(kinds(snapshot), ["InitShell", "Desync"]);
        state.pty.force_kill(&session.id).await.unwrap();
    }
}
