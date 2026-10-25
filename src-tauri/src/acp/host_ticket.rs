//! Host-originated consent tickets on the ACP permission contract.
//!
//! The browser core raises a ticket (`host:<uuid>`) through the
//! [`PermissionRequest`] port. It goes out as an ordinary
//! `acp:permission_request` event carrying `_meta.termul.origin_kind =
//! "browser"`, so every client shows it in its existing permission flow,
//! and it never reaches the agent: the `/ws` `respond_permission` handler
//! and the desktop `browser_ticket_respond` command resolve it here first.
//!
//! Who may answer: the desktop `main` webview, or a `/ws` client that
//! passed the host's token gate and is subscribed to the ticket's session
//! (which binds it to the session's host-stamped project). The first
//! qualified answer wins; an answer within [`ANSWER_FLOOR`] of the prompt
//! being shown is refused, so a click aimed at something that just moved
//! cannot approve it.
//!
//! A session nobody is subscribed to has no one who could answer, so its
//! tickets resolve `Unattended` at once instead of waiting out the consent
//! window; that is how scripted and scheduled runs fail fast.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::browser_automation::core::ports::{
    ActionClass, ConsentOption, PermissionRequest, PortFuture, TabProfile, TicketId, TicketOutcome,
    TicketRequest,
};
use crate::web::sink::WsRelaySink;
use crate::web::EventSink;

pub const ANSWER_FLOOR: Duration = Duration::from_millis(750);

const EVENT_PERMISSION_REQUEST: &str = "acp:permission_request";
pub const EVENT_TICKET_CLOSED: &str = "acp:browser_ticket_closed";

/// Resolved ids remembered so a late answer reads `already_resolved`.
const RESOLVED_MEMORY: usize = 256;

/// Displayed query and fragment are cut at this many bytes.
const DISPLAY_QUERY_BYTES: usize = 96;

/// Who is answering a ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approver {
    /// The desktop `main` webview (checked by the command).
    Desktop,
    Remote {
        /// The connection passed the host's web-token gate.
        token_authenticated: bool,
        /// The connection is subscribed to the ticket's session.
        subscribed: bool,
    },
}

impl Approver {
    pub fn qualifies(self) -> bool {
        match self {
            Approver::Desktop => true,
            Approver::Remote {
                token_authenticated,
                subscribed,
            } => token_authenticated && subscribed,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Approver::Desktop => "desktop",
            Approver::Remote { .. } => "remote",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerError {
    NotFound,
    AlreadyResolved,
    /// Not the desktop and not a token-authenticated client of the session.
    Unqualified,
    /// Answered before [`ANSWER_FLOOR`] elapsed; the ticket stays open.
    TooEarly,
    InvalidOption,
}

impl AnswerError {
    pub fn as_str(self) -> &'static str {
        match self {
            AnswerError::NotFound => "not_found",
            AnswerError::AlreadyResolved => "already_resolved",
            AnswerError::Unqualified => "unqualified_approver",
            AnswerError::TooEarly => "answered_too_early",
            AnswerError::InvalidOption => "invalid_option",
        }
    }
}

fn option_key(option: ConsentOption) -> &'static str {
    match option {
        ConsentOption::AllowSession => "allow_session",
        ConsentOption::AllowProject => "allow_project",
        ConsentOption::Deny => "deny",
    }
}

fn parse_option(id: &str) -> Option<ConsentOption> {
    ConsentOption::ALL
        .into_iter()
        .find(|o| option_key(*o) == id)
}

/// Sensitive actions are allowed one action at a time: their session
/// option means "this once", and their project option pre-approves the
/// action on the origin.
fn is_sensitive(action: ActionClass) -> bool {
    action.is_preapprovable()
}

fn option_name(option: ConsentOption, action: ActionClass) -> &'static str {
    match (option, is_sensitive(action)) {
        (ConsentOption::AllowSession, false) => "Allow for this session",
        (ConsentOption::AllowSession, true) => "Allow once",
        (ConsentOption::AllowProject, false) => "Always allow for this project",
        (ConsentOption::AllowProject, true) => "Always allow on this site for this project",
        (ConsentOption::Deny, _) => "Deny",
    }
}

fn option_scope(option: ConsentOption, action: ActionClass) -> Option<&'static str> {
    match (option, is_sensitive(action)) {
        (ConsentOption::AllowSession, true) => Some("once"),
        _ => option.scope(),
    }
}

fn ticket_title(ticket: &TicketRequest) -> String {
    let origin = ticket.origin.as_str();
    match ticket.action {
        ActionClass::Navigate | ActionClass::LocalNetwork => {
            format!("Open {origin} in the agent browser")
        }
        ActionClass::PasswordSubmit => format!("Submit a password on {origin}"),
        ActionClass::PaymentSubmit => format!("Submit payment details on {origin}"),
        ActionClass::Upload => match &ticket.file {
            Some(file) => format!("Upload {} ({} bytes) to {origin}", file.name, file.bytes),
            None => format!("Upload a file to {origin}"),
        },
        ActionClass::Download => format!("Download a file from {origin}"),
        ActionClass::TaintedExfil => format!("Send page data to {origin}"),
    }
}

fn action_id(action: ActionClass) -> &'static str {
    match action {
        ActionClass::Navigate => "navigate",
        ActionClass::LocalNetwork => "local_network",
        ActionClass::PasswordSubmit => "password_submit",
        ActionClass::PaymentSubmit => "payment_submit",
        ActionClass::Upload => "upload",
        ActionClass::Download => "download",
        ActionClass::TaintedExfil => "tainted_exfil",
    }
}

fn profile_id(profile: TabProfile) -> &'static str {
    match profile {
        TabProfile::Global => "global",
        TabProfile::Ephemeral => "ephemeral",
    }
}

/// The target URL as displayed: query and fragment cut at
/// [`DISPLAY_QUERY_BYTES`]. The full length travels as a byte count.
fn display_url(url: &str) -> String {
    let tail_at = url.find(['?', '#']).unwrap_or(url.len());
    let (head, tail) = url.split_at(tail_at);
    if tail.len() <= DISPLAY_QUERY_BYTES {
        return url.to_string();
    }
    let mut cut = DISPLAY_QUERY_BYTES;
    while !tail.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{head}{}…", &tail[..cut])
}

fn request_payload(ticket: &TicketRequest) -> Value {
    let options: Vec<Value> = ticket
        .options
        .iter()
        .map(|&option| {
            let mut entry = json!({
                "optionId": option_key(option),
                "name": option_name(option, ticket.action),
                "kind": option.acp_kind(),
            });
            if let Some(scope) = option_scope(option, ticket.action) {
                entry["_meta"] = json!({ "termul": { "scope": scope } });
            }
            entry
        })
        .collect();
    json!({
        "sessionId": ticket.session_id,
        "requestId": ticket.id.as_str(),
        "toolCall": {
            "toolCallId": null,
            "title": ticket_title(ticket),
            "kind": "fetch",
            "status": "pending",
        },
        "options": options,
        "_meta": { "termul": {
            "origin_kind": "browser",
            "browser": {
                "origin": ticket.origin.as_str(),
                "targetUrl": display_url(&ticket.target_url),
                "targetUrlBytes": ticket.target_url.len(),
                "action": action_id(ticket.action),
                "element": ticket.element,
                "file": ticket.file.as_ref().map(|f| json!({ "name": f.name, "bytes": f.bytes })),
                "profile": profile_id(ticket.profile),
                "projectId": ticket.project_id,
            },
        }},
    })
}

struct Pending {
    session_id: String,
    options: &'static [ConsentOption],
    shown_at: Instant,
    tx: oneshot::Sender<TicketOutcome>,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, Pending>,
    resolved: VecDeque<String>,
}

impl State {
    fn close(&mut self, id: &str) -> Option<Pending> {
        let pending = self.pending.remove(id)?;
        if self.resolved.len() == RESOLVED_MEMORY {
            self.resolved.pop_front();
        }
        self.resolved.push_back(id.to_string());
        Some(pending)
    }
}

/// Whether a qualified approver is live-subscribed to a session.
pub type AttachedFn = Box<dyn Fn(&str) -> bool + Send + Sync>;

pub struct HostTickets {
    sinks: Vec<Arc<dyn EventSink>>,
    attached: AttachedFn,
    answer_floor: Duration,
    state: Mutex<State>,
}

impl HostTickets {
    pub fn new(sinks: Vec<Arc<dyn EventSink>>, attached: AttachedFn) -> Self {
        Self {
            sinks,
            attached,
            answer_floor: ANSWER_FLOOR,
            state: Mutex::new(State::default()),
        }
    }

    /// Tickets fanned out through the relay, raised only while some client
    /// (the desktop renderer, a phone, a browser) is subscribed to the
    /// ticket's session.
    pub fn for_relay(relay: Arc<WsRelaySink>) -> Self {
        let attached = Arc::clone(&relay);
        Self::new(
            vec![relay],
            Box::new(move |session_id| attached.session_subscriber_count(session_id) > 0),
        )
    }

    #[cfg(test)]
    pub fn with_answer_floor(mut self, floor: Duration) -> Self {
        self.answer_floor = floor;
        self
    }

    /// The session a pending ticket belongs to.
    pub fn session_of(&self, request_id: &str) -> Option<String> {
        self.state
            .lock()
            .pending
            .get(request_id)
            .map(|p| p.session_id.clone())
    }

    pub fn is_pending(&self, request_id: &str) -> bool {
        self.state.lock().pending.contains_key(request_id)
    }

    /// Answer a ticket. `option_id: None` denies.
    pub fn answer(
        &self,
        approver: Approver,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<ConsentOption, AnswerError> {
        let mut state = self.state.lock();
        let Some(pending) = state.pending.get(request_id) else {
            return Err(if state.resolved.iter().any(|id| id == request_id) {
                AnswerError::AlreadyResolved
            } else {
                AnswerError::NotFound
            });
        };
        if !approver.qualifies() {
            drop(state);
            log::warn!(
                "[host-ticket] answer refused reason={} approver={}",
                AnswerError::Unqualified.as_str(),
                approver.label()
            );
            return Err(AnswerError::Unqualified);
        }
        let option = match option_id {
            None => ConsentOption::Deny,
            Some(id) => parse_option(id)
                .filter(|option| pending.options.contains(option))
                .ok_or(AnswerError::InvalidOption)?,
        };
        if pending.shown_at.elapsed() < self.answer_floor {
            drop(state);
            log::warn!(
                "[host-ticket] answer refused reason={} approver={}",
                AnswerError::TooEarly.as_str(),
                approver.label()
            );
            return Err(AnswerError::TooEarly);
        }
        let pending = state.close(request_id).ok_or(AnswerError::NotFound)?;
        drop(state);
        let _ = pending.tx.send(TicketOutcome::Answered(option));
        log::info!(
            "[host-ticket] ticket resolved outcome={} approver={} session={}",
            option_key(option),
            approver.label(),
            crate::logging::redact_session_id(&pending.session_id)
        );
        self.emit_closed(&pending.session_id, request_id, option_key(option));
        Ok(option)
    }

    fn emit_closed(&self, session_id: &str, request_id: &str, outcome: &'static str) {
        crate::acp::events::fan_out(
            &self.sinks,
            Some(session_id),
            EVENT_TICKET_CLOSED,
            &json!({ "sessionId": session_id, "requestId": request_id, "outcome": outcome }),
        );
    }

    /// Close a ticket nobody answered. No-op once it is resolved.
    fn withdraw(&self, request_id: &str, outcome: TicketOutcome, label: &'static str) {
        let Some(pending) = self.state.lock().close(request_id) else {
            return;
        };
        let _ = pending.tx.send(outcome);
        self.emit_closed(&pending.session_id, request_id, label);
    }
}

/// Closes the ticket when the waiting call goes away (Stop, a cancelled
/// tool call), so no surface keeps showing a prompt nobody waits on.
struct Withdraw<'a> {
    tickets: &'a HostTickets,
    id: String,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        self.tickets
            .withdraw(&self.id, TicketOutcome::Cancelled, "cancelled");
    }
}

impl PermissionRequest for HostTickets {
    fn request(&self, ticket: TicketRequest, wait: Duration) -> PortFuture<'_, TicketOutcome> {
        let session = ticket.session_id.clone();
        if !(self.attached)(&session) {
            log::info!(
                "[host-ticket] ticket not raised reason=unattended session={}",
                crate::logging::redact_session_id(&session)
            );
            return Box::pin(async { TicketOutcome::Unattended });
        }
        let id = ticket.id.as_str().to_string();
        let (tx, rx) = oneshot::channel();
        self.state.lock().pending.insert(
            id.clone(),
            Pending {
                session_id: session.clone(),
                options: ticket.options,
                shown_at: Instant::now(),
                tx,
            },
        );
        crate::acp::events::fan_out(
            &self.sinks,
            Some(&session),
            EVENT_PERMISSION_REQUEST,
            &request_payload(&ticket),
        );
        Box::pin(async move {
            let guard = Withdraw { tickets: self, id };
            match tokio::time::timeout(wait, rx).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => TicketOutcome::Cancelled,
                Err(_) => {
                    self.withdraw(&guard.id, TicketOutcome::TimedOut, "timed_out");
                    TicketOutcome::TimedOut
                }
            }
        })
    }

    fn cancel_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .state
            .lock()
            .pending
            .iter()
            .filter(|(_, p)| p.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.withdraw(&id, TicketOutcome::Cancelled, "cancelled");
        }
    }
}

/// `TicketId::parse` for callers outside the browser core.
pub fn is_host_ticket_id(request_id: &str) -> bool {
    TicketId::parse(request_id).is_some()
}

#[cfg(test)]
#[path = "host_ticket_tests.rs"]
mod tests;
