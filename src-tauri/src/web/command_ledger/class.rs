//! The command class table: how every `/ws` request type is treated by the
//! receipt ledger. Mirrored 1:1 by `WS_COMMAND_CLASSES` in
//! `src/shared/types/web-protocol.types.ts`; `class_tests` pins the parity.
//!
//! | kind         | meaning                                                         |
//! |--------------|-----------------------------------------------------------------|
//! | `Create`     | makes a host-minted entity; the `commandId` is stamped on it    |
//! | `Command`    | mutates state, not naturally idempotent                         |
//! | `Idempotent` | sets a value or deletes by id; a repeat answers like the first  |
//! | `Read`       | no mutation                                                     |
//!
//! `Create` and `Command` carry a [`Replay`] policy: `Payload` replays the
//! stored (sanitized) reply, `Entity` rebuilds it from the entity the command
//! stamped, `ReceiptOnly` never stores a payload (credential-bearing kinds).
//! `send_prompt` is `Command` + `Entity`: its `turnId` is its `commandId` and
//! `TurnWatermark` is its entity-lookup layer, so it never enters the ledger.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// What a request type is, for the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClassKind {
    Create,
    Command,
    Idempotent,
    Read,
}

/// How a settled command is answered on a same-id resend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replay {
    /// The stored, size-bounded reply payload.
    Payload,
    /// Rebuilt from the entity that carries the `commandId`.
    Entity,
    /// Success only; the payload (it may carry secrets) is never stored.
    ReceiptOnly,
}

/// One row of the class table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandClass {
    pub kind: ClassKind,
    /// `Some` for `Create` and `Command`.
    pub replay: Option<Replay>,
}

impl CommandClass {
    pub(super) const fn create() -> Self {
        Self {
            kind: ClassKind::Create,
            replay: Some(Replay::Entity),
        }
    }
    pub(super) const fn command(replay: Replay) -> Self {
        Self {
            kind: ClassKind::Command,
            replay: Some(replay),
        }
    }
    pub(super) const fn idempotent() -> Self {
        Self {
            kind: ClassKind::Idempotent,
            replay: None,
        }
    }
    pub(super) const fn read() -> Self {
        Self {
            kind: ClassKind::Read,
            replay: None,
        }
    }

    /// Whether a request of this class with a `commandId` enters the ledger.
    /// `send_prompt` (`Command` + `Entity`) does not: `TurnWatermark` owns it.
    #[must_use]
    pub const fn ledgered(self) -> bool {
        match self.kind {
            ClassKind::Create => true,
            ClassKind::Command => !matches!(self.replay, Some(Replay::Entity)),
            ClassKind::Idempotent | ClassKind::Read => false,
        }
    }

    /// Whether the entity the command created is looked up on a resend that
    /// finds no stored outcome.
    #[must_use]
    pub const fn creates_entity(self) -> bool {
        matches!(self.kind, ClassKind::Create)
    }

    /// Whether the reply payload may be stored for replay.
    #[must_use]
    pub const fn stores_payload(self) -> bool {
        !matches!(self.replay, Some(Replay::ReceiptOnly))
    }
}

/// Every `/ws` request type and its class.
pub const WS_COMMAND_CLASSES: &[(&str, CommandClass)] = &[
    ("send_prompt", CommandClass::command(Replay::Entity)),
    ("cancel_prompt", CommandClass::idempotent()),
    ("set_config_option", CommandClass::idempotent()),
    ("set_mode", CommandClass::idempotent()),
    ("set_model", CommandClass::idempotent()),
    // One-shot tickets: a duplicate answer is `already_resolved`, so a lost
    // reply + resend of the same commandId must replay the original outcome.
    ("respond_permission", CommandClass::command(Replay::Payload)),
    ("answer_question", CommandClass::command(Replay::Payload)),
    ("create_session", CommandClass::create()),
    ("load_session", CommandClass::command(Replay::Payload)),
    ("resume_session", CommandClass::command(Replay::Payload)),
    ("close_session", CommandClass::command(Replay::Payload)),
    (
        "dispose_ephemeral_session",
        CommandClass::command(Replay::Payload),
    ),
    ("promote_session", CommandClass::command(Replay::Payload)),
    ("list_sessions", CommandClass::read()),
    (
        "register_discovered_session",
        CommandClass::command(Replay::Payload),
    ),
    ("spawn_agent", CommandClass::create()),
    ("kill_agent", CommandClass::idempotent()),
    ("list_agents", CommandClass::read()),
    ("authenticate", CommandClass::read()),
    (
        "authenticate_agent",
        CommandClass::command(Replay::ReceiptOnly),
    ),
    ("logout_agent", CommandClass::idempotent()),
    ("delete_agent_session", CommandClass::idempotent()),
    (
        "respond_elicitation",
        CommandClass::command(Replay::ReceiptOnly),
    ),
    ("subscribe", CommandClass::read()),
    ("ping", CommandClass::read()),
    ("list_persisted_sessions", CommandClass::read()),
    ("delete_session", CommandClass::idempotent()),
    ("open_persisted_session", CommandClass::read()),
    ("get_session_payload", CommandClass::read()),
    ("recover_session_snapshot", CommandClass::read()),
    ("get_session_cursor", CommandClass::read()),
    ("get_session_payload_tail", CommandClass::read()),
    ("list_acp_catalog", CommandClass::read()),
    ("set_catalog_opt_in", CommandClass::idempotent()),
    ("install_acp_agent", CommandClass::command(Replay::Payload)),
    (
        "acp_deliver_auth_redirect",
        CommandClass::command(Replay::ReceiptOnly),
    ),
    ("store_read", CommandClass::read()),
    ("store_write", CommandClass::idempotent()),
    ("store_delete", CommandClass::idempotent()),
    ("add_project", CommandClass::idempotent()),
    ("update_project", CommandClass::idempotent()),
    ("remove_project", CommandClass::idempotent()),
    ("set_default_project", CommandClass::idempotent()),
    (
        "record_agent_switch",
        CommandClass::command(Replay::Payload),
    ),
    ("watch_project", CommandClass::read()),
    ("unwatch_project", CommandClass::read()),
    ("watch", CommandClass::read()),
    ("unwatch", CommandClass::read()),
];

/// The class of a `/ws` request type; `None` for a type the host does not
/// serve (it answers `not_implemented`).
#[must_use]
pub fn class_of(request_type: &str) -> Option<(&'static str, CommandClass)> {
    #[cfg(test)]
    if request_type == "panic_for_test" {
        return Some(("panic_for_test", CommandClass::command(Replay::Payload)));
    }
    WS_COMMAND_CLASSES
        .iter()
        .find(|(name, _)| *name == request_type)
        .map(|(name, class)| (*name, *class))
}

/// The payload fields that identify WHAT a request of this type acts on:
/// entity names only (dotted paths reach into objects). Never args, env, text,
/// urls, tokens or any other content, so a fingerprint derives from nothing
/// secret.
fn identifying_fields(request_type: &str) -> &'static [&'static str] {
    match request_type {
        "create_session" => &["agentId", "cwd", "projectId"],
        "spawn_agent" => &["config.name", "config.command", "config.configId"],
        "load_session" | "resume_session" => &["agentId", "sessionId", "cwd"],
        "close_session" | "dispose_ephemeral_session" | "promote_session"
        | "delete_agent_session" => &["agentId", "sessionId"],
        "register_discovered_session" => &["agentId", "sessionId", "cwd", "projectId"],
        "record_agent_switch" => &["sessionId", "fromConfigId", "toConfigId", "newSessionId"],
        "respond_permission" => &["agentId", "requestId", "optionId"],
        "answer_question" => &["agentId", "questionId"],
        "authenticate_agent" => &["agentId", "methodId"],
        "respond_elicitation" => &["agentId", "requestId", "action"],
        "acp_deliver_auth_redirect" | "install_acp_agent" | "logout_agent" | "kill_agent" => {
            &["agentId"]
        }
        _ => &[],
    }
}

/// The scalar (string, number or bool) at a dotted `path` of `payload`, in a
/// type-tagged form so `1`, `"1"` and `true` stay distinct. `null` and an
/// absent field are both "absent".
fn scalar_at(payload: &Value, path: &str) -> Option<String> {
    let value = path
        .split('.')
        .try_fold(payload, |value, key| value.get(key))?;
    match value {
        // Trimmed, and blank means absent: the same normalization the
        // handlers apply to ids (`projectId`), so a request differing only in
        // padding is the same command.
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| format!("s{text}"))
        }
        Value::Number(number) => Some(format!("n{number}")),
        Value::Bool(flag) => Some(format!("b{flag}")),
        _ => None,
    }
}

/// A 128-bit digest of the request type and its identifying fields. Two
/// requests with one `commandId` but different fingerprints are a
/// `command_conflict`; a request differing only in a non-identifying field
/// (args, env, text...) is the same command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint([u8; 16]);

impl Fingerprint {
    #[must_use]
    pub fn of(request_type: &str, payload: &Value) -> Self {
        let fields: Vec<(&str, String)> = identifying_fields(request_type)
            .iter()
            .filter_map(|path| scalar_at(payload, path).map(|value| (*path, value)))
            .collect();
        Self::digest(
            request_type,
            fields.iter().map(|(name, value)| (*name, value.as_str())),
        )
    }

    /// The digest of `request_type` and the named identifying string `fields`
    /// (for carriers that hold the fields directly, not as a JSON payload).
    /// Normalized exactly like [`Fingerprint::of`]: trimmed, blank = absent,
    /// string-tagged, so one request has one fingerprint on every carrier.
    #[must_use]
    pub fn of_fields<'a>(
        request_type: &str,
        fields: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let tagged: Vec<(&str, String)> = fields
            .into_iter()
            .filter_map(|(name, value)| {
                let value = value.trim();
                (!value.is_empty()).then(|| (name, format!("s{value}")))
            })
            .collect();
        Self::digest(
            request_type,
            tagged.iter().map(|(name, value)| (*name, value.as_str())),
        )
    }

    /// Hash already-normalized `(name, tagged value)` pairs.
    fn digest<'a>(
        request_type: &str,
        fields: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(request_type.as_bytes());
        hasher.update([0]);
        for (name, value) in fields {
            hasher.update(name.as_bytes());
            hasher.update([1]);
            hasher.update(value.len().to_le_bytes());
            hasher.update(value.as_bytes());
        }
        let digest = hasher.finalize();
        let mut out = [0u8; 16];
        out.copy_from_slice(&digest[..16]);
        Self(out)
    }
}
