//! Origin consent for agent browser calls: classify the call's target,
//! honour the session's grants and the project allow-list, and raise a
//! host-originated consent ticket for everything else (unless the app opens
//! new sites without asking). Local files the host checked are granted per
//! exact file: project files at once, others after an allow-once ticket.
//! Owns the Stop latch, because Stop revokes exactly what consent grants.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::Url;

use super::authz::{DenyReason, HopVerdict, OriginClass, PromptKind, SessionGrants};
use super::dispatch::Verb;
use super::local_files::LocalFile;
use super::ports::{
    ActionClass, CanonicalOrigin, ConsentOption, PermissionRequest, PolicyRefusal, PolicyStore,
    ProjectPolicyOp, TabProfile, TicketFile, TicketId, TicketOutcome, TicketRequest, TicketTarget,
};
use super::sensitivity::{Sensitive, Taint};
use super::stop::{stopped_error, StopLatch, StopToken};
use super::{BrowserError, DesktopBrowserHost, ERR_CONFIRMATION};
use crate::acp::browser_policy::{OriginPattern, ProjectPreapproval};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::BrowserCall;

/// CAS retries when "always allow for this project" races another edit.
const PERSIST_ATTEMPTS: usize = 3;

pub struct OriginRequest<'a> {
    pub session_id: &'a str,
    pub project_id: &'a str,
    pub url: &'a str,
    pub element: Option<&'a str>,
    pub profile: TabProfile,
    /// The call's deadline: the consent wait never outlasts it.
    pub deadline: Deadline,
}

fn confirmation(reason: &'static str, message: String) -> BrowserError {
    BrowserError::new(ERR_CONFIRMATION, message).with_reason(reason)
}

fn denied(reason: DenyReason) -> BrowserError {
    let message = match reason {
        DenyReason::FileNotGranted => {
            "this session no longer holds access to the local file this tab shows (Stop or a profile change revoked it); call navigate with its url to open it again"
        }
        _ => "this origin is never reachable from the agent browser",
    };
    BrowserError::invalid(message)
        .with_reason(reason.as_str())
        .with_arg_keys(&["url"])
}

fn outcome_label(outcome: &TicketOutcome) -> &'static str {
    match outcome {
        TicketOutcome::Answered(ConsentOption::AllowSession) => "allow_session",
        TicketOutcome::Answered(ConsentOption::AllowProject) => "allow_project",
        TicketOutcome::Answered(ConsentOption::Deny) => "deny",
        TicketOutcome::Unattended => "unattended",
        TicketOutcome::TimedOut => "timed_out",
        TicketOutcome::Cancelled => "cancelled",
    }
}

/// One sensitive action awaiting confirmation.
pub struct SensitiveRequest<'a> {
    pub session_id: &'a str,
    pub project_id: &'a str,
    pub element: Option<&'a str>,
    /// The file an upload sends, named on its ticket.
    pub file: Option<TicketFile>,
    pub profile: TabProfile,
    pub deadline: Deadline,
}

/// Which pre-approvals a tab's identity honours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreapprovalScope {
    Project,
    App,
}

impl PreapprovalScope {
    fn of(profile: TabProfile) -> Self {
        match profile {
            TabProfile::Ephemeral => Self::Project,
            // The global profile's logins are seen by every project.
            TabProfile::Global => Self::App,
        }
    }
}

fn class_phrase(class: ActionClass) -> &'static str {
    match class {
        ActionClass::Navigate => "open",
        ActionClass::LocalNetwork => "open the local network address",
        ActionClass::PasswordSubmit => "submit a password on",
        ActionClass::PaymentSubmit => "submit payment details on",
        ActionClass::Upload => "upload a file to",
        ActionClass::Download => "download a file from",
        ActionClass::TaintedExfil => "send page data to",
    }
}

fn class_id(class: ActionClass) -> &'static str {
    match class {
        ActionClass::Navigate => "navigate",
        ActionClass::LocalNetwork => "local_network",
        ActionClass::PasswordSubmit => "password_submit",
        ActionClass::PaymentSubmit => "payment_submit",
        ActionClass::Upload => "upload",
        ActionClass::Download => "download",
        ActionClass::TaintedExfil => "tainted_exfil",
    }
}

pub struct ConsentGate {
    grants: SessionGrants,
    taint: Taint,
    stop: StopLatch,
    permissions: Arc<dyn PermissionRequest>,
    policy: Arc<dyn PolicyStore>,
    /// One consent ticket per session at a time: a concurrent call for the
    /// same origin waits, then finds the grant instead of prompting again.
    prompts: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Bumped by every policy refresh. A snapshot carries the generation
    /// current when its policy was read, and never replaces a newer one:
    /// a call that read the policy before a refresh cannot write it back
    /// over the refresh.
    policy_generation: std::sync::atomic::AtomicU64,
}

impl ConsentGate {
    pub fn new(
        permissions: Arc<dyn PermissionRequest>,
        policy: Arc<dyn PolicyStore>,
    ) -> Self {
        Self {
            grants: SessionGrants::default(),
            taint: Taint::default(),
            stop: StopLatch::default(),
            permissions,
            policy,
            prompts: Mutex::new(HashMap::new()),
            policy_generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn begin(&self, session_id: &str) -> Result<StopToken, BrowserError> {
        self.stop.begin(session_id)
    }

    pub async fn authorize(
        &self,
        token: &StopToken,
        req: OriginRequest<'_>,
    ) -> Result<(), BrowserError> {
        let url: Url = req
            .url
            .parse()
            .map_err(|_| BrowserError::invalid("invalid url").with_arg_keys(&["url"]))?;
        let lock = self
            .prompts
            .lock()
            .entry(req.session_id.to_string())
            .or_default()
            .clone();
        let _one_prompt = lock.lock().await;
        token.check()?;
        // Read under the session's lock: a call that read the policy
        // earlier cannot overwrite a newer snapshot after this one.
        self.snapshot_policy(req.session_id, req.project_id).await;
        match self.grants.check_hop(req.session_id, &url) {
            HopVerdict::Allow => {
                if self.grants.opened_unasked(req.session_id, &url) {
                    log::info!(
                        "[browser-agent] site opened without a prompt (ask before opening sites is off) session={}",
                        crate::logging::redact_session_id(req.session_id)
                    );
                }
                Ok(())
            }
            HopVerdict::Deny(reason) => {
                log::info!(
                    "[browser-agent] origin denied code={} reason={} keys=[url]",
                    super::ERR_INVALID_PARAMS,
                    reason.as_str()
                );
                Err(denied(reason))
            }
            HopVerdict::Ungranted(kind, origin) => self.prompt(token, &req, kind, origin).await,
        }
    }

    /// The policy changed: refresh the snapshot of every live session now,
    /// so page-started hops follow it before the agent's next call.
    pub async fn refresh_policies(&self, project_of: impl Fn(&str) -> String) {
        let generation = self
            .policy_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
            + 1;
        let sessions = self.grants.session_ids();
        if sessions.is_empty() {
            return;
        }
        let ask_sites = self.asks_before_opening_sites().await;
        for session_id in sessions {
            let allow_list = self.allow_list(&project_of(&session_id)).await;
            self.grants.refresh_policy(&session_id, generation, allow_list, ask_sites);
        }
        log::info!("[browser-agent] live sessions picked up a browser policy change ask_sites={ask_sites}");
    }

    /// Snapshot the project allow-list and the site switch the session's
    /// synchronous hop checks decide from. Callers hold the session's
    /// prompt lock.
    async fn snapshot_policy(&self, session_id: &str, project_id: &str) {
        use std::sync::atomic::Ordering;
        // A refresh that lands while this reads makes the read stale: read
        // again, so the snapshot is never older than the last refresh.
        for _ in 0..3 {
            let generation = self.policy_generation.load(Ordering::Acquire);
            let allow_list = self.allow_list(project_id).await;
            let ask_sites = self.asks_before_opening_sites().await;
            self.grants.set_policy(session_id, generation, allow_list, ask_sites);
            if self.policy_generation.load(Ordering::Acquire) == generation {
                return;
            }
        }
    }

    /// The app's "ask before opening new sites" switch. A policy that
    /// cannot be read asks.
    async fn asks_before_opening_sites(&self) -> bool {
        match self.policy.app().await {
            Ok(app) => app.ask_before_opening_sites,
            Err(error) => {
                log::warn!(
                    "[browser-agent] app policy read failed reason={}; asking before opening sites",
                    error.reason()
                );
                true
            }
        }
    }

    /// Open a local file the host checked: a project file is granted at
    /// once; any other asks this once (allow once or deny), every time
    /// the agent opens it. The grant is the exact real-path URL, which the
    /// engine's hop checks and frame guards then allow.
    pub async fn authorize_file(
        &self,
        token: &StopToken,
        req: &OriginRequest<'_>,
        file: &LocalFile,
    ) -> Result<(), BrowserError> {
        let lock = self
            .prompts
            .lock()
            .entry(req.session_id.to_string())
            .or_default()
            .clone();
        let _one_prompt = lock.lock().await;
        token.check()?;
        // The file page's own web links are verdicted from this snapshot.
        self.snapshot_policy(req.session_id, req.project_id).await;
        let session = crate::logging::redact_session_id(req.session_id);
        if file.inside {
            log::info!("[browser-agent] project file opened without a prompt session={session}");
            return self.keep_file_grant(token, req.session_id, file);
        }
        let ticket = TicketRequest {
            id: TicketId::mint(),
            session_id: req.session_id.to_string(),
            project_id: req.project_id.to_string(),
            origin: TicketTarget::File(file.display()),
            target_url: file.url.to_string(),
            action: ActionClass::Navigate,
            element: req.element.map(str::to_string),
            file: None,
            profile: req.profile,
            options: &ConsentOption::ONCE_OR_DENY,
        };
        let outcome = self
            .permissions
            .request(ticket, req.deadline.clamp(budgets::CONSENT_WAIT))
            .await;
        log::info!(
            "[browser-agent] file consent outcome={} session={session}",
            outcome_label(&outcome)
        );
        match outcome {
            TicketOutcome::Answered(ConsentOption::AllowSession) => self.stop.commit(req.session_id, token, || {
                self.grants.grant_file_once(req.session_id, &file.url, &file.read_access);
            }),
            // Never offered; an answer naming it is treated as a denial. A
            // denial also ends an earlier "allow once" of the same file.
            TicketOutcome::Answered(ConsentOption::AllowProject | ConsentOption::Deny) => {
                self.grants.revoke_file(req.session_id, &file.url);
                Err(confirmation(
                    "denied_by_user",
                    "the user did not allow the agent browser to open this file".to_string(),
                ))
            }
            TicketOutcome::Unattended => Err(confirmation(
                "unattended",
                "no one can approve opening a file outside the project right now; ask the user, or copy it into the project".to_string(),
            )),
            TicketOutcome::TimedOut => Err(confirmation(
                "consent_timeout",
                "the user did not answer the request to open this file".to_string(),
            )),
            TicketOutcome::Cancelled if token.is_stopped() => Err(stopped_error()),
            TicketOutcome::Cancelled => Err(confirmation(
                "consent_cancelled",
                "the request to open this file was withdrawn".to_string(),
            )),
        }
    }

    /// Grant the project file a page on `from` linked to, in one step with
    /// the check that the session still holds `from`, under the locks Stop
    /// and revokes take: `Ok(false)` when `from` lost its grant, an error
    /// when Stop came first.
    pub fn keep_linked_file_grant(
        &self,
        token: &StopToken,
        session_id: &str,
        from: &Url,
        file: &LocalFile,
    ) -> Result<bool, BrowserError> {
        self.stop.commit(session_id, token, || {
            self.grants
                .grant_file_if_held(session_id, from, &file.url, &file.read_access)
        })
    }

    /// Keep the grant of the checked `file` unless Stop came first.
    pub fn keep_file_grant(
        &self,
        token: &StopToken,
        session_id: &str,
        file: &LocalFile,
    ) -> Result<(), BrowserError> {
        self.stop.commit(session_id, token, || {
            self.grants.grant_file(session_id, &file.url, &file.read_access);
        })
    }

    /// The host sent `tab` to the file `url` (see
    /// [`SessionGrants::file_load_dispatched`]).
    pub fn file_load_dispatched(&self, session_id: &str, tab: &str, url: &Url) {
        self.grants.file_load_dispatched(session_id, tab, url);
    }

    /// The load of the file `url` failed (see
    /// [`SessionGrants::file_load_failed`]).
    pub fn file_load_failed(&self, session_id: &str, tab: Option<&str>, url: &Url) {
        if self.grants.file_load_failed(session_id, tab, url) {
            log::info!(
                "[browser-agent] allow-once file grant ended reason=load_failed session={}",
                crate::logging::redact_session_id(session_id)
            );
        }
    }

    /// A call approved to open a file failed before it dispatched the load:
    /// end the "allow once" grants nothing holds or loads (see
    /// [`SessionGrants::end_unused_once_files`]).
    pub fn end_unused_file_grants(&self, session_id: &str) {
        let ended = self.grants.end_unused_once_files(session_id);
        if ended > 0 {
            log::info!(
                "[browser-agent] allow-once file grant ended count={ended} reason=open_failed session={}",
                crate::logging::redact_session_id(session_id)
            );
        }
    }

    /// Tab `tab` of the session committed `url`, or closed (`None`): end
    /// the "allow once" file grants no tab holds any longer.
    pub fn tab_moved(&self, session_id: &str, tab: &str, url: Option<&Url>) {
        let ended = self.grants.tab_moved(session_id, tab, url);
        if ended > 0 {
            log::info!(
                "[browser-agent] allow-once file grant ended count={ended} reason=tab_left_file session={}",
                crate::logging::redact_session_id(session_id)
            );
        }
    }

    /// Whether the session holds a grant for the exact file `url`, and the
    /// directory its page may read.
    pub fn file_read_access(&self, session_id: &str, url: &Url) -> Option<std::path::PathBuf> {
        self.grants.file_read_access(session_id, url)
    }

    async fn allow_list(&self, project_id: &str) -> Vec<OriginPattern> {
        match self.policy.project(project_id).await {
            Ok(policy) => policy.allow_list,
            Err(error) => {
                log::warn!(
                    "[browser-agent] policy read failed reason={}; using an empty allow-list",
                    error.reason()
                );
                Vec::new()
            }
        }
    }

    async fn prompt(
        &self,
        token: &StopToken,
        req: &OriginRequest<'_>,
        kind: PromptKind,
        origin: CanonicalOrigin,
    ) -> Result<(), BrowserError> {
        let ticket = TicketRequest {
            id: TicketId::mint(),
            session_id: req.session_id.to_string(),
            project_id: req.project_id.to_string(),
            origin: origin.clone().into(),
            target_url: req.url.to_string(),
            action: kind.action(),
            element: req.element.map(str::to_string),
            file: None,
            profile: req.profile,
            options: &ConsentOption::ALL,
        };
        let outcome = self
            .permissions
            .request(ticket, req.deadline.clamp(budgets::CONSENT_WAIT))
            .await;
        log::info!(
            "[browser-agent] consent outcome={} session={}",
            outcome_label(&outcome),
            crate::logging::redact_session_id(req.session_id)
        );
        let origin_text = origin.as_str().to_string();
        match outcome {
            TicketOutcome::Answered(ConsentOption::AllowSession) => self.keep_grant(token, req.session_id, origin),
            TicketOutcome::Answered(ConsentOption::AllowProject) => {
                token.check()?;
                self.persist_origin(req.project_id, &origin).await;
                self.keep_grant(token, req.session_id, origin)
            }
            TicketOutcome::Answered(ConsentOption::Deny) => Err(confirmation(
                "denied_by_user",
                format!("the user denied the agent browser access to {origin_text}"),
            )),
            TicketOutcome::Unattended => Err(confirmation(
                "unattended",
                format!(
                    "no one can approve {origin_text} right now; ask the user to allow it or add it to the project's browser allow-list"
                ),
            )),
            TicketOutcome::TimedOut => Err(confirmation(
                "consent_timeout",
                format!("the user did not answer the request to open {origin_text}"),
            )),
            TicketOutcome::Cancelled if token.is_stopped() => Err(stopped_error()),
            TicketOutcome::Cancelled => Err(confirmation(
                "consent_cancelled",
                format!("the request to open {origin_text} was withdrawn"),
            )),
        }
    }

    fn keep_grant(
        &self,
        token: &StopToken,
        session_id: &str,
        origin: CanonicalOrigin,
    ) -> Result<(), BrowserError> {
        self.stop
            .commit(session_id, token, || self.grants.grant(session_id, origin))
    }

    async fn persist_origin(&self, project_id: &str, origin: &CanonicalOrigin) {
        self.persist(project_id, || ProjectPolicyOp::AddOrigin(OriginPattern::Exact(origin.clone())))
            .await;
    }

    async fn persist(&self, project_id: &str, op: impl Fn() -> ProjectPolicyOp) {
        let mut expected = match self.policy.project(project_id).await {
            Ok(policy) => policy.revision,
            Err(error) => {
                log::warn!("[browser-agent] consent persist failed reason={}", error.reason());
                return;
            }
        };
        for _ in 0..PERSIST_ATTEMPTS {
            match self.policy.apply_project(project_id, expected, op()).await {
                Ok(_) => return,
                Err(PolicyRefusal::RevisionConflict { current }) => expected = current,
                Err(error) => {
                    log::warn!("[browser-agent] consent persist failed reason={}", error.reason());
                    return;
                }
            }
        }
        log::warn!("[browser-agent] consent persist failed reason=revision_conflict");
    }

    /// The agent read page content: from now on the session is tainted.
    pub fn taint(&self, session_id: &str) {
        self.taint.mark(session_id);
    }

    pub fn is_tainted(&self, session_id: &str) -> bool {
        self.taint.is_tainted(session_id)
    }

    /// The origins the user vouched for: loopback, and for ephemeral tabs
    /// the project's allow-list. A global tab's logins outlive the project
    /// whose list vouched for the origin. A site opened without a prompt,
    /// and a local file, is never vouched for.
    pub fn vouched_for(&self, session_id: &str, url: &Url, profile: TabProfile) -> bool {
        match self.grants.class_of(session_id, url) {
            OriginClass::Loopback => true,
            OriginClass::AllowListed => profile == TabProfile::Ephemeral,
            _ => false,
        }
    }

    /// Confirm one sensitive class of an action: a pre-approval at the
    /// scope of the tab's identity covers it, otherwise the user is asked
    /// about this one action.
    pub async fn confirm_sensitive(
        &self,
        token: &StopToken,
        req: &SensitiveRequest<'_>,
        item: &Sensitive,
    ) -> Result<(), BrowserError> {
        // Signing in is the agent's to do unless the user asked to confirm
        // it. A pinned item stands for any credential submit, payments
        // included, so it always asks.
        if item.class == ActionClass::PasswordSubmit && !item.pinned && !self.asks_before_password_submit().await {
            return Ok(());
        }
        let phrase = class_phrase(item.class);
        let Some(origin) = item.origin.clone() else {
            return Err(confirmation(
                "sensitive_origin_unknown",
                format!("the agent cannot {phrase} a page without a web origin"),
            ));
        };
        let scope = PreapprovalScope::of(req.profile);
        if !item.pinned && self.preapproved(scope, req.project_id, item.class, &origin).await {
            log::info!(
                "[browser-agent] sensitive action pre-approved class={} session={}",
                class_id(item.class),
                crate::logging::redact_session_id(req.session_id)
            );
            return Ok(());
        }
        let lock = self
            .prompts
            .lock()
            .entry(req.session_id.to_string())
            .or_default()
            .clone();
        let _one_prompt = lock.lock().await;
        token.check()?;
        let offer_project = scope == PreapprovalScope::Project && !item.pinned;
        let ticket = TicketRequest {
            id: TicketId::mint(),
            session_id: req.session_id.to_string(),
            project_id: req.project_id.to_string(),
            origin: origin.clone().into(),
            target_url: item.target.clone(),
            action: item.class,
            element: req.element.map(str::to_string),
            file: req.file.clone().filter(|_| item.class == ActionClass::Upload),
            profile: req.profile,
            options: if offer_project {
                &ConsentOption::ALL
            } else {
                &ConsentOption::ONCE_OR_DENY
            },
        };
        let outcome = self
            .permissions
            .request(ticket, req.deadline.clamp(budgets::CONSENT_WAIT))
            .await;
        log::info!(
            "[browser-agent] sensitive consent class={} outcome={} session={}",
            class_id(item.class),
            outcome_label(&outcome),
            crate::logging::redact_session_id(req.session_id)
        );
        let what = format!("{phrase} {}", origin.as_str());
        match outcome {
            TicketOutcome::Answered(ConsentOption::AllowSession) => token.check(),
            TicketOutcome::Answered(ConsentOption::AllowProject) => {
                token.check()?;
                if offer_project {
                    if let Ok(item) = ProjectPreapproval::new(item.class, origin) {
                        self.persist(req.project_id, || ProjectPolicyOp::AddPreapproval(item.clone()))
                            .await;
                    }
                }
                Ok(())
            }
            TicketOutcome::Answered(ConsentOption::Deny) => Err(confirmation(
                "denied_by_user",
                format!("the user did not allow the agent to {what}"),
            )),
            TicketOutcome::Unattended => Err(confirmation(
                "unattended",
                format!(
                    "no one can approve this right now: the agent wants to {what}; ask the user, or have them pre-approve it in the browser settings"
                ),
            )),
            TicketOutcome::TimedOut => Err(confirmation(
                "consent_timeout",
                format!("the user did not answer the request to {what}"),
            )),
            TicketOutcome::Cancelled if token.is_stopped() => Err(stopped_error()),
            TicketOutcome::Cancelled => Err(confirmation(
                "consent_cancelled",
                format!("the request to {what} was withdrawn"),
            )),
        }
    }

    /// The app's "ask before an agent submits a password" switch. A policy
    /// that cannot be read asks.
    async fn asks_before_password_submit(&self) -> bool {
        self.policy.app().await.map_or(true, |app| app.ask_before_password_submit)
    }

    async fn preapproved(
        &self,
        scope: PreapprovalScope,
        project_id: &str,
        class: ActionClass,
        origin: &CanonicalOrigin,
    ) -> bool {
        let read = match scope {
            PreapprovalScope::Project => self
                .policy
                .project(project_id)
                .await
                .map(|p| p.preapproves(class, origin)),
            PreapprovalScope::App => self.policy.app().await.map(|p| p.preapproves(class, origin)),
        };
        read.unwrap_or_else(|error| {
            log::warn!("[browser-agent] pre-approval read failed reason={}", error.reason());
            false
        })
    }

    /// Stop: latch the session, revoke its grants and withdraw its pending
    /// tickets. Returns false when it was already stopped.
    pub fn stop(&self, session_id: &str) -> bool {
        let first = self
            .stop
            .stop(session_id, || self.grants.revoke_session(session_id));
        self.permissions.cancel_session(session_id);
        first
    }

    /// The session's tabs lost the profile its grants were given under:
    /// revoke its origin grants and withdraw its pending tickets. Unlike
    /// `stop` it leaves no latch, and unlike `end_session` it keeps an
    /// active Stop, the taint and the session's state.
    pub fn revoke_access(&self, session_id: &str) {
        self.grants.revoke_session(session_id);
        self.permissions.cancel_session(session_id);
    }

    /// The user's next prompt turn. Returns whether the session was stopped.
    pub fn resume(&self, session_id: &str) -> bool {
        self.stop.resume(session_id)
    }

    pub fn is_stopped(&self, session_id: &str) -> bool {
        self.stop.is_stopped(session_id)
    }

    pub fn check_hop(&self, session_id: &str, url: &Url) -> HopVerdict {
        self.grants.check_hop(session_id, url)
    }

    /// See [`SessionGrants::opened_unasked`].
    pub fn opened_unasked(&self, session_id: &str, url: &Url) -> bool {
        self.grants.opened_unasked(session_id, url)
    }

    pub fn end_session(&self, session_id: &str) {
        self.stop.forget(session_id);
        self.grants.forget_session(session_id);
        self.taint.forget(session_id);
        self.prompts.lock().remove(session_id);
        self.permissions.cancel_session(session_id);
    }
}

impl DesktopBrowserHost {
    /// The URL a call needs consent for: the target of `navigate` and
    /// `new_tab`, otherwise the page the targeted tab shows now. `None`
    /// when the call reaches no page or its tab does not resolve (the verb
    /// itself then reports the error).
    fn consent_target(&self, session_id: &str, verb: Verb, call: &BrowserCall) -> Option<String> {
        match verb {
            Verb::Navigate | Verb::NewTab => call
                .args
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            Verb::ListTabs | Verb::CloseTab => None,
            _ => {
                let label = self.resolve_tab(session_id, &call.args).ok()?;
                self.registry.lock().get(&label).map(|record| record.url.clone())
            }
        }
    }

    pub(super) async fn authorize_call(
        &self,
        token: &StopToken,
        session_id: &str,
        verb: Verb,
        call: &BrowserCall,
        deadline: Deadline,
    ) -> Result<(), BrowserError> {
        let Some(url) = self.consent_target(session_id, verb, call) else {
            return Ok(());
        };
        let project_id = (self.project_of)(session_id);
        let profile = self.call_profile(session_id, verb, call).await;
        let request = OriginRequest {
            session_id,
            project_id: &project_id,
            url: &url,
            element: call.element.as_deref(),
            profile,
            deadline,
        };
        // A file the agent asks to open is checked on disk first; a tab
        // already showing a file passes on its exact grant alone.
        if matches!(verb, Verb::Navigate | Verb::NewTab) && super::local_files::is_file_url(&url) {
            let file = self.check_local_file(session_id, &url, deadline).await?;
            return self.gate.authorize_file(token, &request, &file).await;
        }
        self.gate.authorize(token, request).await?;
        self.authorize_frames(token, session_id, call, &project_id, profile, deadline)
            .await?;
        let keys_to_focus = matches!(verb, Verb::Press | Verb::Type)
            && call.args.get("ref").and_then(Value::as_str).is_none();
        if keys_to_focus {
            self.authorize_focused_frame(token, session_id, call, &project_id, profile, deadline)
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "consent_tests.rs"]
mod tests;
