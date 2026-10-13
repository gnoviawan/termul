//! Connect pipeline: TCP → SSH handshake → host key → authentication.
//!
//! Built on russh. The host-key question is asked from inside the handshake
//! (`check_server_key`) and may wait for the user; every other step runs
//! under an inactivity limit that pauses while that question is open.
//! Failures are classified into [`ConnectErrorKind`] so the UI can explain
//! what happened and what to do next; `detail` is technical context and
//! never contains a secret.

use super::keys::{self, KeyFileStatus};
use super::known_hosts::{self, HostKeyInfo, HostKeyStatus};
use russh::client::{self, AuthResult, DisconnectReason, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::MethodKind;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

/// Budget for opening the TCP connection across all resolved addresses.
pub const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A handshake or auth step that makes no progress for this long fails.
const STEP_TIMEOUT: Duration = Duration::from_secs(20);
/// Send an SSH keepalive after this much silence from the server...
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// ...and drop the connection after this many go unanswered.
const KEEPALIVE_MAX: usize = 3;
/// TCP keepalive, so a dead network path also surfaces at the socket.
const TCP_KEEPALIVE_IDLE: Duration = Duration::from_secs(15);
const TCP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
/// How often a waiting step checks for cancellation and its time limit.
const GUARD_TICK: Duration = Duration::from_millis(100);
/// Keyboard-interactive rounds before giving up (servers may loop).
const MAX_KBD_ROUNDS: usize = 5;

type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectErrorKind {
    InvalidTarget,
    DnsFailed,
    ConnectionRefused,
    Timeout,
    Unreachable,
    HandshakeFailed,
    HostKeyRejected,
    HostKeyChanged,
    HostKeyUnknown,
    PasswordRequired,
    PassphraseRequired,
    PassphraseIncorrect,
    AuthFailed,
    AuthMethodUnavailable,
    KeyNotFound,
    KeyInvalid,
    AgentUnavailable,
    Cancelled,
    ShellFailed,
    Internal,
}

impl ConnectErrorKind {
    /// IPC error code; the renderer maps it to user-facing copy.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidTarget => "SSH_INVALID_TARGET",
            Self::DnsFailed => "SSH_DNS_FAILED",
            Self::ConnectionRefused => "SSH_CONNECTION_REFUSED",
            Self::Timeout => "SSH_TIMEOUT",
            Self::Unreachable => "SSH_UNREACHABLE",
            Self::HandshakeFailed => "SSH_HANDSHAKE_FAILED",
            Self::HostKeyRejected => "SSH_HOST_KEY_REJECTED",
            Self::HostKeyChanged => "SSH_HOST_KEY_CHANGED",
            Self::HostKeyUnknown => "SSH_HOST_KEY_UNKNOWN",
            Self::PasswordRequired => "SSH_PASSWORD_REQUIRED",
            Self::PassphraseRequired => "SSH_PASSPHRASE_REQUIRED",
            Self::PassphraseIncorrect => "SSH_PASSPHRASE_INCORRECT",
            Self::AuthFailed => "SSH_AUTH_FAILED",
            Self::AuthMethodUnavailable => "SSH_AUTH_METHOD_UNAVAILABLE",
            Self::KeyNotFound => "SSH_KEY_NOT_FOUND",
            Self::KeyInvalid => "SSH_KEY_INVALID",
            Self::AgentUnavailable => "SSH_AGENT_UNAVAILABLE",
            Self::Cancelled => "SSH_CANCELLED",
            Self::ShellFailed => "SSH_SHELL_FAILED",
            Self::Internal => "SSH_INTERNAL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectError {
    pub kind: ConnectErrorKind,
    pub detail: String,
}

impl ConnectError {
    pub fn new(kind: ConnectErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    fn cancelled() -> Self {
        Self::new(ConnectErrorKind::Cancelled, "Cancelled")
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind.code(), self.detail)
    }
}

/// Progress reported to the UI while connecting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Connecting,
    VerifyingHostKey,
    Authenticating,
    StartingShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    Trust,
    Reject,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Callbacks into the caller while connecting.
pub trait ConnectHooks: Send + Sync {
    fn stage(&self, _stage: Stage) {}
    /// Ask whether to trust an unknown or changed key.
    fn host_key(&self, info: HostKeyInfo, status: HostKeyStatus) -> BoxFuture<'_, HostKeyDecision>;
    fn cancelled(&self) -> bool {
        false
    }
    /// True when `host_key` puts the question to a person, so a rejection
    /// is the user's choice rather than a missing prior trust.
    fn asks_user(&self) -> bool {
        false
    }
}

/// State shared between the connect pipeline, the russh handler and the
/// session that owns the connection afterwards.
#[derive(Default)]
pub struct ConnectionState {
    /// Why the host key check refused the server (classifies the failure).
    host_key_rejection: Mutex<Option<ConnectError>>,
    /// Why the connection ended, for the "connection lost" detail.
    disconnect_reason: Mutex<Option<String>>,
    /// A host-key question is open; the step timer is paused.
    prompting: AtomicBool,
    /// Last progress, for the step timer.
    last_progress: Mutex<Option<Instant>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

impl ConnectionState {
    fn mark_progress(&self) {
        *lock(&self.last_progress) = Some(Instant::now());
    }

    fn idle_for(&self) -> Duration {
        lock(&self.last_progress).map_or(Duration::ZERO, |at| at.elapsed())
    }

    pub fn disconnect_reason(&self) -> Option<String> {
        lock(&self.disconnect_reason).clone()
    }
}

/// russh client handler: host key policy and disconnect bookkeeping.
pub struct ClientHandler {
    host: String,
    port: u16,
    hooks: Arc<dyn ConnectHooks>,
    state: Arc<ConnectionState>,
}

impl ClientHandler {
    fn reject(&self, error: ConnectError) -> Result<bool, russh::Error> {
        *lock(&self.state.host_key_rejection) = Some(error);
        Ok(false)
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        self.hooks.stage(Stage::VerifyingHostKey);
        let status = match known_hosts::check(&self.host, self.port, &key) {
            Ok(status) => status,
            Err(e) => return self.reject(ConnectError::new(ConnectErrorKind::Internal, e)),
        };
        if status == HostKeyStatus::Trusted {
            return Ok(true);
        }
        let info = known_hosts::info_for(&self.host, self.port, &key);
        if status == HostKeyStatus::Revoked {
            log::warn!("[SSH] Host key for {} is revoked in known_hosts", info.host);
            return self.reject(ConnectError::new(
                ConnectErrorKind::HostKeyRejected,
                format!(
                    "This host key is marked @revoked in known_hosts ({})",
                    info.fingerprint
                ),
            ));
        }
        self.state.prompting.store(true, Ordering::Release);
        let decision = self.hooks.host_key(info.clone(), status).await;
        self.state.prompting.store(false, Ordering::Release);
        self.state.mark_progress();
        match decision {
            HostKeyDecision::Trust => {
                // The user trusted this key for this connection; a failure to
                // remember it only means they are asked again next time.
                if let Err(e) = known_hosts::trust(&self.host, self.port, &key) {
                    log::warn!("[SSH] Could not save trusted host key: {}", e);
                }
                Ok(true)
            }
            HostKeyDecision::Reject if self.hooks.cancelled() => {
                self.reject(ConnectError::cancelled())
            }
            HostKeyDecision::Reject => {
                let kind = if self.hooks.asks_user() {
                    ConnectErrorKind::HostKeyRejected
                } else if status == HostKeyStatus::Changed {
                    ConnectErrorKind::HostKeyChanged
                } else {
                    ConnectErrorKind::HostKeyUnknown
                };
                self.reject(ConnectError::new(kind, info.fingerprint))
            }
        }
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let text = match &reason {
            DisconnectReason::ReceivedDisconnect(_) => {
                "The server closed the connection".to_string()
            }
            DisconnectReason::Error(e) => e.to_string(),
        };
        lock(&self.state.disconnect_reason).get_or_insert(text);
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

/// Where to connect and how to authenticate.
pub struct Target<'a> {
    pub host: &'a str,
    pub port: u16,
    pub username: &'a str,
    /// `password` | `key` | `agent`
    pub auth_method: &'a str,
    pub key_path: Option<&'a str>,
}

/// An authenticated connection.
pub struct Connected {
    pub handle: Handle<ClientHandler>,
    pub state: Arc<ConnectionState>,
}

pub(crate) fn validate_target(target: &Target) -> Result<(), ConnectError> {
    let invalid = |detail: &str| Err(ConnectError::new(ConnectErrorKind::InvalidTarget, detail));
    let host = target.host.trim();
    if host.is_empty() {
        return invalid("Host is empty");
    }
    if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return invalid("Host contains spaces or control characters");
    }
    if target.port == 0 {
        return invalid("Port must be between 1 and 65535");
    }
    if target.username.trim().is_empty() {
        return invalid("Username is empty");
    }
    Ok(())
}

pub(crate) fn classify_io(error: &std::io::Error) -> ConnectErrorKind {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::ConnectionRefused => ConnectErrorKind::ConnectionRefused,
        ErrorKind::TimedOut | ErrorKind::WouldBlock => ConnectErrorKind::Timeout,
        _ => ConnectErrorKind::Unreachable,
    }
}

/// Resolve and connect with one shared deadline across all addresses, so a
/// dual-stack host whose IPv6 route black-holes still falls back to IPv4.
pub async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, ConnectError> {
    // One deadline covers the lookup and the connect attempts, so a stalled
    // resolver cannot hold this step past it.
    let deadline = Instant::now() + TCP_CONNECT_TIMEOUT;
    let resolved: Vec<_> =
        tokio::time::timeout(TCP_CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| {
                ConnectError::new(ConnectErrorKind::DnsFailed, "Looking up the host timed out")
            })?
            .map_err(|e| ConnectError::new(ConnectErrorKind::DnsFailed, e.to_string()))?
            .collect();
    if resolved.is_empty() {
        return Err(ConnectError::new(
            ConnectErrorKind::DnsFailed,
            "No addresses returned",
        ));
    }

    let per_attempt = std::cmp::max(
        TCP_CONNECT_TIMEOUT / resolved.len() as u32,
        Duration::from_secs(2),
    );
    let mut last = ConnectError::new(ConnectErrorKind::Timeout, "Connection timed out");
    for addr in resolved {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let attempt = tokio::time::timeout(
            std::cmp::min(per_attempt, remaining),
            TcpStream::connect(addr),
        );
        match attempt.await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => last = ConnectError::new(classify_io(&e), e.to_string()),
            Err(_) => last = ConnectError::new(ConnectErrorKind::Timeout, "Connection timed out"),
        }
    }
    Err(last)
}

fn tune_socket(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(TCP_KEEPALIVE_IDLE)
        .with_interval(TCP_KEEPALIVE_INTERVAL);
    if let Err(e) = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive) {
        log::warn!("[SSH] Could not enable TCP keepalive: {}", e);
    }
}

/// Run one step, failing on cancel or when it makes no progress for
/// `STEP_TIMEOUT` (the clock pauses while a host-key question is open).
async fn guarded<T>(
    step: impl Future<Output = T>,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Result<T, ConnectError> {
    state.mark_progress();
    tokio::pin!(step);
    let mut tick = tokio::time::interval(GUARD_TICK);
    loop {
        tokio::select! {
            out = &mut step => return Ok(out),
            _ = tick.tick() => {
                if hooks.cancelled() {
                    return Err(ConnectError::cancelled());
                }
                if state.prompting.load(Ordering::Acquire) {
                    state.mark_progress();
                } else if state.idle_for() > STEP_TIMEOUT {
                    return Err(ConnectError::new(
                        ConnectErrorKind::Timeout,
                        "The server stopped responding",
                    ));
                }
            }
        }
    }
}

/// Classify a protocol-level failure.
fn protocol_error(
    error: russh::Error,
    state: &ConnectionState,
    hooks: &dyn ConnectHooks,
) -> ConnectError {
    if hooks.cancelled() {
        return ConnectError::cancelled();
    }
    if let Some(rejection) = lock(&state.host_key_rejection).take() {
        return rejection;
    }
    let kind = match &error {
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => {
            ConnectErrorKind::Timeout
        }
        russh::Error::IO(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            ConnectErrorKind::Timeout
        }
        _ => ConnectErrorKind::HandshakeFailed,
    };
    ConnectError::new(kind, error.to_string())
}

async fn wait_cancelled(hooks: &dyn ConnectHooks) {
    while !hooks.cancelled() {
        tokio::time::sleep(GUARD_TICK).await;
    }
}

/// Run the full pipeline and return an authenticated connection.
pub async fn connect(
    target: &Target<'_>,
    secret: Option<&str>,
    hooks: Arc<dyn ConnectHooks>,
) -> Result<Connected, ConnectError> {
    validate_target(target)?;
    let host = target.host.trim();
    let state = Arc::new(ConnectionState::default());

    hooks.stage(Stage::Connecting);
    let tcp = tokio::select! {
        result = connect_tcp(host, target.port) => result?,
        _ = wait_cancelled(&*hooks) => return Err(ConnectError::cancelled()),
    };
    tune_socket(&tcp);

    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        nodelay: true,
        ..Default::default()
    });
    let handler = ClientHandler {
        host: host.to_string(),
        port: target.port,
        hooks: hooks.clone(),
        state: state.clone(),
    };
    let mut handle = guarded(
        client::connect_stream(config, tcp, handler),
        &*hooks,
        &state,
    )
    .await?
    .map_err(|e| protocol_error(e, &state, &*hooks))?;

    hooks.stage(Stage::Authenticating);
    authenticate(&mut handle, target, secret, &*hooks, &state).await?;
    Ok(Connected { handle, state })
}

fn method_name(method: &MethodKind) -> &'static str {
    match method {
        MethodKind::None => "none",
        MethodKind::Password => "password",
        MethodKind::PublicKey => "publickey",
        MethodKind::HostBased => "hostbased",
        MethodKind::KeyboardInteractive => "keyboard-interactive",
        MethodKind::GssapiWithMic => "gssapi-with-mic",
    }
}

/// Answers the first keyboard-interactive prompt round with the password.
/// Later rounds (one-time codes) get empty answers rather than the password.
pub(crate) fn kbd_answers(prompts: &[bool], password: &str, answered: bool) -> Vec<String> {
    prompts
        .iter()
        .map(|echo| {
            if !answered && !echo {
                password.to_string()
            } else {
                String::new()
            }
        })
        .collect()
}

async fn keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    password: &str,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Result<bool, ConnectError> {
    let mut response = guarded(
        handle.authenticate_keyboard_interactive_start(user, None::<String>),
        hooks,
        state,
    )
    .await?
    .map_err(|e| protocol_error(e, state, hooks))?;
    let mut answered = false;
    for _ in 0..MAX_KBD_ROUNDS {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let echoes: Vec<bool> = prompts.iter().map(|p| p.echo).collect();
                let answers = kbd_answers(&echoes, password, answered);
                answered |= !echoes.is_empty();
                response = guarded(
                    handle.authenticate_keyboard_interactive_respond(answers),
                    hooks,
                    state,
                )
                .await?
                .map_err(|e| protocol_error(e, state, hooks))?;
            }
        }
    }
    Ok(false)
}

/// RSA signature hash the server accepts (rsa-sha2-512/256, else legacy).
async fn rsa_hash(
    handle: &Handle<ClientHandler>,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Option<HashAlg> {
    match guarded(handle.best_supported_rsa_hash(), hooks, state).await {
        Ok(Ok(Some(hash))) => hash,
        // No server-sig-algs extension: an old server that only knows SHA-1.
        Ok(Ok(None)) => None,
        _ => Some(HashAlg::Sha256),
    }
}

#[cfg(unix)]
async fn connect_agent() -> Result<DynAgent, String> {
    AgentClient::connect_env()
        .await
        .map(AgentClient::dynamic)
        .map_err(|e| format!("No SSH agent found (SSH_AUTH_SOCK): {}", e))
}

#[cfg(windows)]
async fn connect_agent() -> Result<DynAgent, String> {
    match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(openssh) => AgentClient::connect_pageant()
            .await
            .map(AgentClient::dynamic)
            .map_err(|pageant| {
                format!(
                    "No SSH agent found (OpenSSH agent: {}; Pageant: {})",
                    openssh, pageant
                )
            }),
    }
}

async fn authenticate_with_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    key_path: Option<&str>,
    secret: Option<&str>,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Result<bool, ConnectError> {
    let path = key_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            ConnectError::new(ConnectErrorKind::KeyNotFound, "No private key selected")
        })?;
    let info = keys::inspect(path);
    let unusable = |kind, detail: &str| Err(ConnectError::new(kind, detail));
    match info.status {
        KeyFileStatus::Ok => {}
        KeyFileStatus::NotFound => {
            return unusable(ConnectErrorKind::KeyNotFound, "Key file not found")
        }
        KeyFileStatus::Unreadable => {
            return unusable(ConnectErrorKind::KeyInvalid, "Key file could not be read")
        }
        KeyFileStatus::NotPrivateKey => {
            return unusable(
                ConnectErrorKind::KeyInvalid,
                "The file is not a private key",
            )
        }
    }
    let passphrase = secret.filter(|s| !s.is_empty());
    if info.encrypted && passphrase.is_none() {
        return unusable(
            ConnectErrorKind::PassphraseRequired,
            "The key is protected by a passphrase",
        );
    }
    let key = russh::keys::load_secret_key(&info.path, passphrase).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => ConnectError::new(
            ConnectErrorKind::PassphraseRequired,
            "The key is protected by a passphrase",
        ),
        other if info.encrypted => {
            ConnectError::new(ConnectErrorKind::PassphraseIncorrect, other.to_string())
        }
        other => ConnectError::new(ConnectErrorKind::KeyInvalid, other.to_string()),
    })?;
    let hash = if key.algorithm().is_rsa() {
        rsa_hash(handle, hooks, state).await
    } else {
        None
    };
    let result = guarded(
        handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
        hooks,
        state,
    )
    .await?
    .map_err(|e| protocol_error(e, state, hooks))?;
    Ok(result.success())
}

async fn authenticate_with_agent(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Result<bool, ConnectError> {
    let agent_error = |e: String| ConnectError::new(ConnectErrorKind::AgentUnavailable, e);
    // An unresponsive agent must still honour cancel and the step timeout.
    let mut agent = guarded(connect_agent(), hooks, state)
        .await?
        .map_err(agent_error)?;
    let identities = guarded(agent.request_identities(), hooks, state)
        .await?
        .map_err(|e| agent_error(e.to_string()))?;
    let keys: Vec<PublicKey> = identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            _ => None,
        })
        .collect();
    if keys.is_empty() {
        return Err(agent_error("The SSH agent has no keys loaded".to_string()));
    }
    for key in keys {
        let hash = if key.algorithm().is_rsa() {
            rsa_hash(handle, hooks, state).await
        } else {
            None
        };
        match guarded(
            handle.authenticate_publickey_with(user, key, hash, &mut agent),
            hooks,
            state,
        )
        .await?
        {
            Ok(result) if result.success() => return Ok(true),
            Ok(_) => {}
            Err(e) => log::warn!("[SSH] Agent signing failed: {}", e),
        }
    }
    Ok(false)
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    target: &Target<'_>,
    secret: Option<&str>,
    hooks: &dyn ConnectHooks,
    state: &ConnectionState,
) -> Result<(), ConnectError> {
    let user = target.username.trim();
    // "none" auth tells us which methods the server accepts.
    let methods: Vec<MethodKind> = match guarded(handle.authenticate_none(user), hooks, state)
        .await?
        .map_err(|e| protocol_error(e, state, hooks))?
    {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods.to_vec(),
    };
    let offers = |method: MethodKind| methods.contains(&method);
    let unavailable = |what: &str| {
        let offered: Vec<&str> = methods.iter().map(method_name).collect();
        ConnectError::new(
            ConnectErrorKind::AuthMethodUnavailable,
            format!(
                "Server does not accept {} (offers: {})",
                what,
                offered.join(", ")
            ),
        )
    };

    let (accepted, rejection) = match target.auth_method {
        "password" => {
            let password = secret.ok_or_else(|| {
                ConnectError::new(ConnectErrorKind::PasswordRequired, "Password required")
            })?;
            let password_offered = offers(MethodKind::Password);
            let kbd_offered = offers(MethodKind::KeyboardInteractive);
            if !password_offered && !kbd_offered {
                return Err(unavailable("passwords"));
            }
            let mut accepted = password_offered
                && guarded(handle.authenticate_password(user, password), hooks, state)
                    .await?
                    .map_err(|e| protocol_error(e, state, hooks))?
                    .success();
            if !accepted && kbd_offered {
                accepted = keyboard_interactive(handle, user, password, hooks, state).await?;
            }
            (accepted, "Password rejected")
        }
        "key" => {
            if !offers(MethodKind::PublicKey) {
                return Err(unavailable("keys"));
            }
            let accepted =
                authenticate_with_key(handle, user, target.key_path, secret, hooks, state).await?;
            (accepted, "The server did not accept this key")
        }
        "agent" => {
            if !offers(MethodKind::PublicKey) {
                return Err(unavailable("keys"));
            }
            let accepted = authenticate_with_agent(handle, user, hooks, state).await?;
            (accepted, "No key in the SSH agent was accepted")
        }
        other => {
            return Err(ConnectError::new(
                ConnectErrorKind::InvalidTarget,
                format!("Unknown authentication method: {}", other),
            ))
        }
    };
    if accepted {
        Ok(())
    } else {
        Err(ConnectError::new(ConnectErrorKind::AuthFailed, rejection))
    }
}

#[cfg(test)]
mod tests;
