//! Transport-neutral event sink for the ACP dispatcher.
//!
//! The dispatcher (see `crate::acp::manager` + `crate::acp::client`) emits every
//! agent/session event through a fan-out of [`EventSink`] trait objects instead
//! of calling `AppHandle::emit` directly. That decouples the live session stream
//! from Tauri so the same dispatcher can feed:
//!
//! - the desktop's Tauri events ([`TauriEventSink`] — byte-for-byte preserves the
//!   existing `acp:*` event names + payloads the renderer depends on), and
//! - the future web's WebSocket relay ([`WsRelaySink`] — stubbed here as an
//!   in-memory recorder; wired live in Story 1.4).
//!
//! # Design rules baked in (do not deviate)
//!
//! - **Serialize ONCE, fan out N.** [`fan_out`] serializes the payload to a
//!   `serde_json::Value` once; every sink emits the same `Value`, so
//!   `TauriEventSink` and `WsRelaySink` emit byte-identical payloads.
//! - **`type_` keeps the `acp:` prefix.** [`TauriEventSink`] emits it verbatim
//!   (today's behavior); `WsRelaySink` will strip the prefix when the WS relay
//!   lands in Story 1.4. For this story the stub records the full string.
//! - **`sid` is `Option<String>`.** `None` for agent-level events
//!   (`agent_spawned`, `agent_disconnected`, `agent_error` without a session);
//!   `Some(session_id)` for session-scoped events. Matches the WS envelope
//!   `{sid, seq, type, payload}` shape (Story 1.4).
//!
//! `AcpManager` holds `Vec<Arc<dyn EventSink>>` and threads clones into every
//! driver spawn site, so `AppHandle` no longer reaches the driver thread. The
//! ONLY remaining `AppHandle` reference in the ACP stack lives inside
//! [`TauriEventSink`] (the desktop's sink — intentionally Tauri-aware).

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// A single ACP event ready for fan-out.
///
/// `sid` is the session id (`None` for agent-level events like `agent_spawned`
/// / `agent_disconnected`). `type_` is the existing `acp:*` event name with the
/// `acp:` prefix (e.g. `"acp:message_chunk"`) — [`TauriEventSink`] emits it
/// verbatim; `WsRelaySink` will strip the prefix when the WS relay lands in
/// Story 1.4. `payload` is the serialized JSON value so every sink emits
/// byte-identical bytes (serialize ONCE, fan out N times).
#[derive(Clone, Debug)]
pub struct AcpEvent {
    pub sid: Option<String>,
    pub type_: &'static str,
    pub payload: Value,
}

/// Transport-neutral sink for ACP events.
///
/// Object-safe (`dyn EventSink` usable via `Arc<dyn EventSink>`) and `Send +
/// Sync` so clones can cross from the Tauri command thread into each agent's
/// dedicated driver thread (see `AcpManager`'s threading model).
pub trait EventSink: Send + Sync {
    /// Deliver a single event. Errors must be logged, never propagated — a
    /// missing renderer (or a wedged WS peer) must never tear down the agent
    /// driver thread.
    fn emit(&self, event: &AcpEvent);
}

/// Desktop sink: forwards events to the Tauri renderer as `acp:*` events.
///
/// Byte-for-byte preserves the existing `events::emit(app, event, payload)`
/// behavior — same event names, same payloads (the `Value` was produced by the
/// same `serde_json::to_value` the old free function used implicitly via
/// `app.emit`), same error-logging-not-propagating semantics.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    /// Wrap a Tauri app handle. The sink is cheap to construct and `Clone`-free
    /// (it shares the handle via `AppHandle`'s internal `Arc`).
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &AcpEvent) {
        if let Err(e) = self.app.emit(event.type_, event.payload.clone()) {
            log::error!("[acp] failed to emit event {}: {e}", event.type_);
        }
    }
}

/// Web relay sink (STUB — Story 1.4 wires it to a live WS relay).
///
/// For this story it is a pure in-memory recorder: every emitted event is
/// appended to a `parking_lot::Mutex<Vec<AcpEvent>>` so tests can drain and
/// assert order + content. It is constructible WITHOUT a Tauri `AppHandle`, so
/// the standalone `termul-server` binary (Story 1.2) can pass `[WsRelaySink]`
/// (or a live variant of it) to `AcpManager::new`.
///
/// `dead_code` is allowed because no production code path constructs this yet
/// — it is only exercised by `web::sink::tests` in this story. Story 1.4 wires
/// it into a live WS relay (and into `AcpManager`'s sink list for the headless
/// binary), at which point the `allow` can be removed.
#[allow(dead_code)]
pub struct WsRelaySink {
    recorded: Mutex<Vec<AcpEvent>>,
}

#[allow(dead_code)]
impl WsRelaySink {
    /// Create an empty recorder.
    #[must_use]
    pub fn new() -> Self {
        Self {
            recorded: Mutex::new(Vec::new()),
        }
    }

    /// Drain all recorded events in emission order, leaving the sink empty.
    /// Intended for test assertions; the live WS relay (Story 1.4) will not
    /// expose this.
    #[must_use]
    pub fn drain(&self) -> Vec<AcpEvent> {
        self.recorded.lock().drain(..).collect()
    }
}

impl Default for WsRelaySink {
    fn default() -> Self {
        Self::new()
    }
}

impl EventSink for WsRelaySink {
    fn emit(&self, event: &AcpEvent) {
        // Record the full event (with the `acp:` prefix intact). Story 1.4 will
        // strip the prefix + add seq/cursor envelope framing here.
        self.recorded.lock().push(event.clone());
    }
}

/// Fan an event out to every sink, serializing the payload ONCE so each sink
/// emits byte-identical JSON.
///
/// `sid` is `None` for agent-level events, `Some(session_id)` for
/// session-scoped events. `type_` is the `acp:*` event name (with prefix).
/// `payload` is serialized to a `serde_json::Value` here, then handed to each
/// sink by reference — `TauriEventSink` re-serializes via `app.emit` (which
/// accepts a `Value` directly) and `WsRelaySink` records the `Value` as-is.
///
/// Returns early without emitting when `sinks` is empty (avoids a wasted
/// serialization + allocation on the `vec![]` path blessed for unit tests) or
/// when the payload fails to serialize. A serialization failure is logged and
/// the event is dropped — preserving the old `events::emit` drop-and-log
/// semantics (a non-JSON-serializable payload must NOT be emitted as a `null`
/// payload on the wire).
pub fn fan_out<P: Serialize>(
    sinks: &[Arc<dyn EventSink>],
    sid: Option<&str>,
    type_: &'static str,
    payload: &P,
) {
    if sinks.is_empty() {
        return;
    }
    let payload = match serde_json::to_value(payload) {
        Ok(v) => v,
        Err(e) => {
            log::error!("[acp] skipping {type_} event: payload failed to serialize: {e}");
            return;
        }
    };
    let event = AcpEvent {
        sid: sid.map(str::to_string),
        type_,
        payload,
    };
    for sink in sinks {
        sink.emit(&event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;

    /// A minimal serializable payload for sink tests — exercises the same
    /// `serde_json::to_value` path the real event structs use.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TestPayload {
        agent_id: String,
        session_id: String,
        message: String,
    }

    impl TestPayload {
        fn new(agent: &str, session: &str, msg: &str) -> Self {
            Self {
                agent_id: agent.to_string(),
                session_id: session.to_string(),
                message: msg.to_string(),
            }
        }
    }

    /// AC: `WsRelaySink` records events in emission order (Task 8.1).
    #[test]
    fn ws_relay_sink_records_events_in_order() {
        let ws = Arc::new(WsRelaySink::new());
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-1"),
            "acp:message_chunk",
            &TestPayload::new("a1", "sess-1", "first"),
        );
        fan_out(
            &sinks,
            Some("sess-1"),
            "acp:message_chunk",
            &TestPayload::new("a1", "sess-1", "second"),
        );
        fan_out(
            &sinks,
            None,
            "acp:agent_disconnected",
            &TestPayload::new("a1", "sess-1", "third"),
        );

        let drained = ws.drain();
        assert_eq!(drained.len(), 3, "exactly three events were recorded");
        assert_eq!(drained[0].type_, "acp:message_chunk");
        assert_eq!(drained[0].sid.as_deref(), Some("sess-1"));
        assert_eq!(drained[0].payload["message"], "first");
        assert_eq!(drained[1].payload["message"], "second");
        assert_eq!(drained[2].type_, "acp:agent_disconnected");
        assert!(
            drained[2].sid.is_none(),
            "agent-level event must carry no sid"
        );
        // camelCase wire shape is preserved end-to-end.
        assert_eq!(drained[0].payload["agentId"], "a1");
        assert_eq!(drained[0].payload["sessionId"], "sess-1");
    }

    /// AC: `WsRelaySink` + `TauriEventSink` in the same fan-out both receive
    /// the SAME event (Task 8.2). We can't construct a real `AppHandle` in a
    /// unit test, so we assert the contract that matters for byte-identity:
    /// the `AcpEvent` handed to every sink carries the SAME serialized
    /// `Value` (serialize-once-fan-out-N). A custom sink records the `Value`
    /// the way `TauriEventSink` would emit it; we then assert the WS recorder
    /// saw an identical `Value`.
    #[test]
    fn fan_out_delivers_identical_payload_to_every_sink() {
        /// A second recorder used as a stand-in for `TauriEventSink`'s view of
        /// the event (we can't build a real `AppHandle` here). It captures the
        /// exact `AcpEvent` handed to `emit`.
        struct CapturingSink {
            seen: Mutex<Vec<AcpEvent>>,
        }
        impl EventSink for CapturingSink {
            fn emit(&self, event: &AcpEvent) {
                self.seen.lock().push(event.clone());
            }
        }

        let ws = Arc::new(WsRelaySink::new());
        let tauri_stand_in = Arc::new(CapturingSink {
            seen: Mutex::new(Vec::new()),
        });
        let sinks: Vec<Arc<dyn EventSink>> = vec![tauri_stand_in.clone(), ws.clone()];

        fan_out(
            &sinks,
            Some("sess-7"),
            "acp:tool_call",
            &TestPayload::new("a2", "sess-7", "hello"),
        );

        let tauri_view = tauri_stand_in.seen.lock().drain(..).collect::<Vec<_>>();
        let ws_view = ws.drain();

        assert_eq!(tauri_view.len(), 1);
        assert_eq!(ws_view.len(), 1);
        assert_eq!(tauri_view[0].type_, ws_view[0].type_);
        assert_eq!(tauri_view[0].sid, ws_view[0].sid);
        assert_eq!(
            tauri_view[0].payload, ws_view[0].payload,
            "both sinks must see the SAME serialized Value (serialize-once-fan-out-N)"
        );
        assert_eq!(ws_view[0].payload["message"], "hello");
    }

    /// `fan_out` with an empty sink list is a no-op (the dispatcher must not
    /// panic when constructed with `vec![]`, e.g. in unit tests of the manager).
    #[test]
    fn fan_out_with_no_sinks_is_a_no_op() {
        let sinks: Vec<Arc<dyn EventSink>> = vec![];
        fan_out(
            &sinks,
            Some("sess-x"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-x", "m"),
        );
        // No panic, no assertion needed beyond reaching this point.
    }

    /// `WsRelaySink::drain` clears the buffer so subsequent emits start fresh.
    #[test]
    fn ws_relay_sink_drain_clears_buffer() {
        let ws = Arc::new(WsRelaySink::new());
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            None,
            "acp:agent_spawned",
            &TestPayload::new("a", "s", "m"),
        );
        let first = ws.drain();
        assert_eq!(first.len(), 1);
        let second = ws.drain();
        assert!(second.is_empty(), "drain must clear the buffer");
    }

    /// A payload whose `Serialize` impl always errors — deterministically
    /// exercises `fan_out`'s serialization-failure branch. The real-world
    /// trigger is an `f64::NaN`/`Infinity` in a field like
    /// `UsageCostEvent.amount`, but a custom failing serializer avoids
    /// depending on `serde_json`'s float policy.
    struct AlwaysFailsPayload;
    impl Serialize for AlwaysFailsPayload {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(<S::Error as serde::ser::Error>::custom(
                "intentional serialization failure for test",
            ))
        }
    }

    /// P1: a serialization failure must NOT emit a `null` payload on the wire
    /// — the event is dropped (preserving the old `events::emit` semantics).
    #[test]
    fn fan_out_skips_emission_when_payload_fails_to_serialize() {
        let ws = Arc::new(WsRelaySink::new());
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-nan"),
            "acp:usage_update",
            &AlwaysFailsPayload,
        );
        assert!(
            ws.drain().is_empty(),
            "serialization failure must not emit a null payload"
        );
    }

    /// Mirrors the real event structs' `#[serde(skip_serializing_if = ...)]`
    /// pattern (e.g. `SessionCreatedEvent`/`AgentErrorEvent`/`UsageUpdateEvent`)
    /// without coupling this test to `crate::acp::events` internals.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SkipIfPayload {
        agent_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        optional_field: Option<String>,
    }

    /// P2: the `Value` produced by `fan_out` must match a direct
    /// `serde_json::to_value` of the same struct, including `skip_serializing_if`
    /// fields (a `None` optional field must be ABSENT, not emitted as `null`).
    /// This guards against any future `Value`-intermediate regression that would
    /// silently break byte-identity for real event structs.
    #[test]
    fn fan_out_preserves_skip_serializing_if_byte_identity() {
        let ws = Arc::new(WsRelaySink::new());
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        let payload = SkipIfPayload {
            agent_id: "a1".to_string(),
            optional_field: None,
        };
        let direct = serde_json::to_value(&payload).unwrap();
        fan_out(&sinks, Some("sess-skip"), "acp:session_created", &payload);
        let recorded = ws.drain();
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0].payload, direct,
            "fan_out's Value must match direct to_value, including skip_serializing_if"
        );
        assert!(
            recorded[0].payload.get("optionalField").is_none(),
            "skipped Option::None field must be absent from the wire payload, not null"
        );
        assert_eq!(recorded[0].payload["agentId"], "a1");
    }

    /// P2: compile-time proof that `EventSink` and its implementations are
    /// `Send + Sync` (the trait requires it, so `Arc<dyn EventSink>` can cross
    /// from the Tauri command thread into each agent's dedicated driver
    /// thread). A future field change that breaks this would fail to compile.
    #[test]
    fn event_sink_trait_and_impls_are_send_sync() {
        fn assert_send_sync<T: Send + Sync + ?Sized>() {}
        assert_send_sync::<AcpEvent>();
        assert_send_sync::<WsRelaySink>();
        assert_send_sync::<dyn EventSink>();
        assert_send_sync::<Arc<dyn EventSink>>();
        assert_send_sync::<Vec<Arc<dyn EventSink>>>();
    }
}
