//! Host-level fault harness for the `/ws` relay (AD-16, test-only).
//!
//! Drives the unmodified production `run_relay` over an in-memory
//! fault-injecting carrier ([`carrier`]) with a fake agent whose command
//! handling reproduces the real loop (`AcpManager::install_test_agent_with_scripts`:
//! real `DriverState` single-flight, the real turn terminators, a slow /
//! failing `Authenticate`). [`raw_client`] covers the cases that need a real
//! upgraded socket (terminal teardown, host stop).
//!
//! The AD-19 relay-execution repros are named `audit_*` (`cargo test --lib audit_`).

pub(crate) mod carrier;
pub(crate) mod raw_client;
pub(crate) mod wire;

#[cfg(test)]
mod relay_approval_tests;
#[cfg(test)]
mod relay_bounded_tests;
#[cfg(test)]
mod relay_execution_tests;
#[cfg(test)]
mod relay_command_tests;
#[cfg(test)]
mod relay_fault_tests;
#[cfg(test)]
mod relay_contract_tests;
#[cfg(test)]
mod relay_liveness_tests;
#[cfg(test)]
mod relay_prompt_tests;
#[cfg(test)]
mod watch_hub_tests;
mod store_tests;
#[cfg(test)]
mod watch_scoped_tests;
#[cfg(test)]
mod watch_tests;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::*;
use carrier::{pair, Peer};

pub(crate) const AGENT: &str = "agent-h";
pub(crate) const SESSION: &str = "sess-h";

/// A host: the relay sink (also a sink of the ACP manager, as on the server)
/// + the shared `AppState`.
pub(crate) struct Host {
    pub(crate) relay: Arc<WsRelaySink>,
    pub(crate) state: AppState,
    /// The desktop Channel host over the same pieces, built on first use.
    channel: std::sync::OnceLock<(crate::web::ws::channel::WsChannelHost, tempfile::TempDir)>,
}

impl Host {
    /// A host whose single agent (`AGENT`, owning `SESSION`) is installed by
    /// `install`. The session is known to the relay so `subscribe` succeeds.
    pub(crate) fn new(install: impl FnOnce(&Arc<AcpManager>, HashSet<String>)) -> Self {
        let relay = Arc::new(WsRelaySink::new());
        relay.seed_session_for_test(SESSION);
        let acp = Arc::new(AcpManager::new(vec![relay.clone()]));
        install(&acp, HashSet::from([SESSION.to_string()]));
        Self::from_parts(relay, acp, HistoryMode::LiveOnly)
    }

    /// A host over an existing relay + manager (tests that build their own,
    /// e.g. with durable persistence or an injected ledger clock).
    pub(crate) fn from_parts(
        relay: Arc<WsRelaySink>,
        acp: Arc<AcpManager>,
        history_mode: HistoryMode,
    ) -> Self {
        let pty = crate::web::test_pty_manager();
        let state = AppState {
            acp: Arc::clone(&acp),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::clone(&relay),
            registry: Arc::new(ProjectRegistry::new()),
            history_mode,
            acp_catalog: None,
            acp_install: None,
            store: None,
            web_auth: None,
            allow_remote_writes: false,
            shared_live_writes_denied: false,
            pending_oauth_flows: Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            connections: Default::default(),
        };
        Self {
            relay,
            state,
            channel: std::sync::OnceLock::new(),
        }
    }

    /// The desktop's Channel host (`AppState::desktop_local`) sharing this
    /// host's ACP manager, relay, registry and PTYs. Its own connection
    /// runtime is what `WsChannelHost::drain` stops.
    pub(crate) fn channel_host(&self) -> &crate::web::ws::channel::WsChannelHost {
        &self
            .channel
            .get_or_init(|| {
                let scratch = tempfile::tempdir().expect("scratch store dir");
                let store = crate::web::store::WebStore::open(
                    scratch.path().join("store.json"),
                    crate::web::store::StorePolicy::default(),
                )
                .expect("open the scratch store");
                let state = AppState::desktop_local(crate::web::router::DesktopLocalParts {
                    acp: Arc::clone(&self.state.acp),
                    pty: Arc::clone(&self.state.pty),
                    relay: Arc::clone(&self.relay),
                    registry: Arc::clone(&self.state.registry),
                    acp_catalog: None,
                    acp_install: None,
                    store: Arc::new(store),
                });
                (crate::web::ws::channel::WsChannelHost::new(state), scratch)
            })
            .0
    }

    /// Attach a store (the default host runs without one, as in degraded mode).
    pub(crate) fn with_store(mut self, store: Arc<crate::web::store::WebStore>) -> Self {
        self.state.store = Some(store);
        self
    }

    /// Open a connection: the production relay loop on a fault carrier.
    pub(crate) fn connect(&self) -> Conn {
        let (carrier, peer) = pair();
        let (done_tx, done) = watch::channel(false);
        let state = self.state.clone();
        // Admitted before the task is spawned, like the upgrade handler does,
        // so a stop cannot drain past a connection that has not started yet.
        let lease = state.connections.shutdown.admit();
        let task = tokio::spawn(async move {
            // Signals completion on a normal exit or a cancel, never on a panic.
            struct Finished(watch::Sender<bool>);
            impl Drop for Finished {
                fn drop(&mut self) {
                    // A panic is not a completion: the waiting test must
                    // fail by timeout, not pass its reaping assertion.
                    if !std::thread::panicking() {
                        let _ = self.0.send(true);
                    }
                }
            }
            let _finished = Finished(done_tx);
            // The harness peer is a local, write-capable connection.
            let local_peer = SocketAddr::from(([127, 0, 0, 1], 0));
            serve_socket(lease, carrier, state, local_peer, Carrier::Ws).await;
        });
        Conn { peer, task, done }
    }
}

/// One relay connection: the peer-side handle plus the relay task.
pub(crate) struct Conn {
    pub(crate) peer: Peer,
    pub(crate) task: JoinHandle<()>,
    /// Flips to `true` once `run_relay` (including its cleanup) has returned.
    done: watch::Receiver<bool>,
}

impl Conn {
    /// Run the versioned `authenticate` handshake and require `ok`.
    pub(crate) async fn authenticate(&mut self) {
        self.authenticate_as("device-harness", "tab-harness").await;
    }

    /// `authenticate` as one tab of one device.
    pub(crate) async fn authenticate_as(&mut self, device_id: &str, client_instance_id: &str) {
        let reply = self
            .request(
                "auth",
                "authenticate",
                json!({
                    "protocolVersion": WS_PROTOCOL_VERSION,
                    "deviceId": device_id,
                    "clientInstanceId": client_instance_id,
                }),
            )
            .await;
        assert_eq!(reply["ok"], true, "handshake refused: {reply}");
    }

    /// Send a request frame and wait for its reply.
    pub(crate) async fn request(&mut self, id: &str, type_: &str, payload: Value) -> Value {
        self.send_request(id, type_, payload);
        self.peer.wait_reply(id).await
    }

    pub(crate) fn send_request(&self, id: &str, type_: &str, payload: Value) {
        self.peer
            .send_json(&json!({"id": id, "type": type_, "payload": payload}));
    }

    pub(crate) async fn subscribe(&mut self, id: &str) -> Value {
        let reply = self
            .request(id, "subscribe", json!({"sessionId": SESSION}))
            .await;
        assert_eq!(reply["ok"], true, "subscribe refused: {reply}");
        reply
    }

    pub(crate) fn send_prompt_request(&self, id: &str, turn_id: &str) {
        self.send_request(
            id,
            "send_prompt",
            json!({
                "agentId": AGENT,
                "sessionId": SESSION,
                "text": "hello",
                "turnId": turn_id,
            }),
        );
    }

    /// Run every ready task to its next await. Under a paused current-thread
    /// runtime the clock only auto-advances once no task is runnable, so
    /// sleeping one virtual millisecond returns after all queued work (frame
    /// handling, cleanup) has run: a quiescence barrier, not a guess at a
    /// number of scheduler turns.
    pub(crate) async fn settle() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    /// Whether the relay loop (including its cleanup) has returned. Waits on
    /// the explicit completion signal, bounded by the same quiescence barrier:
    /// the signal is observed if the relay finishes with the runtime idle, and
    /// `false` means it is still running with nothing left to run now.
    pub(crate) async fn relay_finished(&self) -> bool {
        let mut done = self.done.clone();
        let finished = tokio::time::timeout(
            Duration::from_millis(1),
            done.wait_for(|finished| *finished),
        )
        .await
        .is_ok();
        finished
    }
}
