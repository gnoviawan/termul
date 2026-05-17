use crate::commands::IpcResult;
use crate::pty::{PtyManager, SpawnOptions};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker};
use axum::{
    Router,
    extract::{ConnectInfo, State, WebSocketUpgrade},
    response::{Html, IntoResponse},
    routing::get,
};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, broadcast};
use tower_http::cors::CorsLayer;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

#[derive(Clone)]
struct AppState {
    auth_token: String,
    token_expiry_secs: u64,
    token_created_at: u64,
    index_html: String,
    app_handle: AppHandle,
    server: Arc<WsServer>,
}

async fn index_handler(State(state): State<AppState>) -> impl IntoResponse {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let token_expired = now >= state.token_created_at + state.token_expiry_secs;
    let token = if token_expired {
        log::warn!("[WsServer] Token expired, generating new one");
        state.server.rotate_token().await
    } else {
        state.auth_token.clone()
    };
    let html = state.index_html
        .replace("__TERMUL_TOKEN__", &token)
        .replace("__TERMUL_TOKEN_EXPIRES__", &(state.token_created_at + state.token_expiry_secs).to_string());
    Html(html)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let token_expired = now >= state.token_created_at + state.token_expiry_secs;

    if token_expired {
        log::warn!("[WsServer] Rejecting WS connection: token expired");
        return ws.on_upgrade(move |_| async move {
            log::info!("[WsServer] Dropped expired connection");
        });
    }

    let server = state.server;
    let token = state.auth_token;
    let app = state.app_handle;
    
    // Cloudflare Tunnel tidak mengirimkan proper SocketAddr peer yang valid lewat ConnectInfo
    // jika kita menggunakan server global biasa, yang memicu error internal di axum extractor.
    // Kita gunakan fallback socket address tiruan agar extractor tidak crash.
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    server.log_connection(&addr, "connecting");

    ws.on_upgrade(move |socket| handle_ws(socket, server, token, app, addr))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsInbound {
    Auth { token: String },
    Request {
        id: String,
        method: String,
        #[serde(default)]
        params: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsOutbound {
    Response {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    Event {
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    Pong(Vec<u8>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsServerStatus {
    pub is_running: bool,
    pub port: u16,
    pub client_count: usize,
    pub http_url: String,
    pub ws_url: String,
    pub use_https: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAudit {
    pub timestamp: String,
    pub remote_addr: String,
    pub event: String,
    pub authenticated: bool,
    pub client_id: Option<String>,
}

struct WsClient {
    authenticated: bool,
    tx: tokio::sync::mpsc::UnboundedSender<WsOutbound>,
    connected_at: Instant,
}

pub struct WsServer {
    config: Mutex<Option<(u16, String, bool)>>,
    status: Mutex<WsServerStatus>,
    clients: Mutex<HashMap<String, WsClient>>,
    event_tx: broadcast::Sender<WsOutbound>,
    running: AtomicBool,
    self_weak: std::sync::Mutex<Option<std::sync::Weak<WsServer>>>,
    audit_log: Mutex<Vec<ConnectionAudit>>,
    current_token: Mutex<String>,
    token_created_at: AtomicU64,
    token_ttl_secs: AtomicU64,
    auth_attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

const DEFAULT_TOKEN_TTL_SECS: u64 = 3600;

impl WsServer {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(2048);
        let initial_token = Self::generate_token();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        Self {
            config: Mutex::new(None),
            status: Mutex::new(WsServerStatus {
                is_running: false,
                port: 9876,
                client_count: 0,
                http_url: String::new(),
                ws_url: String::new(),
                use_https: false,
            }),
            clients: Mutex::new(HashMap::new()),
            event_tx,
            running: AtomicBool::new(false),
            self_weak: std::sync::Mutex::new(None),
            audit_log: Mutex::new(Vec::new()),
            current_token: Mutex::new(initial_token),
            token_created_at: AtomicU64::new(now),
            token_ttl_secs: AtomicU64::new(DEFAULT_TOKEN_TTL_SECS),
            auth_attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn init_arc() -> Arc<Self> {
        let server = Arc::new(Self::new());
        let weak = Arc::downgrade(&server);
        *server.self_weak.lock().unwrap() = Some(weak);
        server
    }

    pub fn generate_token() -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..32).map(|_| rng.sample(rand::distributions::Alphanumeric) as char).collect()
    }

    pub async fn rotate_token(&self) -> String {
        let new_token = Self::generate_token();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let mut token = self.current_token.lock().await;
        *token = new_token.clone();
        self.token_created_at.store(now, Ordering::SeqCst);
        log::info!("[WsServer] Token rotated");
        new_token
    }

    pub async fn get_token_info(&self) -> (String, u64, u64) {
        let token = self.current_token.lock().await.clone();
        let created = self.token_created_at.load(Ordering::SeqCst);
        let ttl = self.token_ttl_secs.load(Ordering::SeqCst);
        (token, created, ttl)
    }

    pub fn log_connection(&self, addr: &SocketAddr, event: &str) {
        let audit = ConnectionAudit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            remote_addr: addr.to_string(),
            event: event.to_string(),
            authenticated: false,
            client_id: None,
        };
        tokio::spawn({
            let server = self.clone_for_audit();
            async move {
                let mut log = server.audit_log.lock().await;
                log.push(audit);
                let len = log.len();
                if len > 1000 {
                    log.drain(..len - 500);
                }
            }
        });
    }

    fn clone_for_audit(&self) -> Arc<Self> {
        self.self_weak.lock().unwrap().as_ref().unwrap().upgrade().unwrap()
    }

    pub async fn get_audit_log(&self) -> Vec<ConnectionAudit> {
        self.audit_log.lock().await.clone()
    }

    pub async fn is_rate_limited(&self, addr: &SocketAddr) -> bool {
        let key = addr.ip().to_string();
        let now = Instant::now();
        let mut attempts = self.auth_attempts.lock().await;

        // Clean up old entries
        attempts.retain(|_, (count, time)| time.elapsed() < Duration::from_secs(60) && *count < 10);

        if let Some((count, time)) = attempts.get_mut(&key) {
            if time.elapsed() > Duration::from_secs(60) {
                *count = 1;
                *time = now;
                false
            } else if *count >= 10 {
                true
            } else {
                *count += 1;
                false
            }
        } else {
            attempts.insert(key, (1, now));
            false
        }
    }

    pub fn emit_event(&self, event: &str, payload: serde_json::Value) {
        let _ = self.event_tx.send(WsOutbound::Event {
            event: event.to_string(),
            payload: Some(payload),
        });
    }

    pub async fn start(
        &self,
        app_handle: AppHandle,
        port: u16,
        auth_token: String,
        use_https: bool,
    ) -> Result<WsServerStatus, String> {
        let is_running = self.running.load(Ordering::SeqCst);
        if is_running {
            return Err("Server is already running".to_string());
        }

        if is_port_in_use(port).await {
            return Err(format!("Port {} is already in use", port));
        }

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        *self.current_token.lock().await = auth_token.clone();
        self.token_created_at.store(now, Ordering::SeqCst);

        {
            let mut config_guard = self.config.lock().await;
            *config_guard = Some((port, auth_token.clone(), use_https));
        }

        self.running.store(true, Ordering::SeqCst);

        let server = self.clone_for_audit();
        tokio::spawn(async move {
            if let Err(e) = server.clone().run_server(app_handle, port, auth_token, use_https).await {
                log::error!("[WsServer] Server error: {}", e);
            }
            server.running.store(false, Ordering::SeqCst);
            let mut status = server.status.lock().await;
            status.is_running = false;
        });

        let scheme = if use_https { "https" } else { "http" };
        let ws_scheme = if use_https { "wss" } else { "ws" };
        let local_ip = get_local_ip().unwrap_or_else(|| "127.0.0.1".to_string());

        let mut status = self.status.lock().await;
        status.is_running = true;
        status.port = port;
        status.http_url = format!("{}://localhost:{}", scheme, port);
        status.ws_url = format!("{}://localhost:{}", ws_scheme, port);
        status.use_https = use_https;

        log::info!("[WsServer] Server started on {}://{}:{}", scheme, local_ip, port);
        log::info!("[WsServer] Local URL: {}://localhost:{}", scheme, port);
        log::info!("[WsServer] Network URL: {}://{}:{}", scheme, local_ip, port);

        Ok(status.clone())
    }

    pub async fn stop(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("Server is not running".to_string());
        }
        self.running.store(false, Ordering::SeqCst);
        let clients = self.clients.lock().await;
        for client in clients.values() {
            let _ = client.tx.send(WsOutbound::Event {
                event: "server-shutdown".to_string(),
                payload: Some(serde_json::json!({"reason": "server_stopped"})),
            });
        }
        log::info!("[WsServer] Server stopping");
        Ok(())
    }

    pub async fn get_status(&self) -> WsServerStatus {
        let status = self.status.lock().await;
        status.clone()
    }

    async fn run_server(
        self: Arc<Self>,
        app_handle: AppHandle,
        port: u16,
        _auth_token: String,
        use_https: bool,
    ) -> Result<(), String> {
        let cors = build_cors();
        let index_html = get_index_html();
        let token_info = self.get_token_info().await;

        let app_state = AppState {
            auth_token: token_info.0.clone(),
            token_expiry_secs: token_info.2,
            token_created_at: token_info.1,
            index_html: index_html.to_string(),
            app_handle: app_handle.clone(),
            server: self.clone(),
        };

        let app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/", get(index_handler))
            .fallback(get(index_handler))
            .layer(cors)
            .with_state(app_state);

        let addr = SocketAddr::from(([0, 0, 0, 0], port));

        if use_https {
            let _ = generate_self_signed_cert(port);
            log::info!("[WsServer] HTTPS requested - serving HTTP with self-signed cert generation ready");
            log::warn!("[WsServer] For production HTTPS, use a reverse proxy (nginx/caddy) with proper certs.");
        }

        let listener = tokio::net::TcpListener::bind(addr).await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("Port {} is already in use. Choose a different port.", port)
                } else {
                    format!("Failed to bind to {}: {}", addr, e)
                }
            })?;

        log::info!("[WsServer] HTTP/WS server listening on http://{}", addr);

        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal(self.clone()))
            .await
            .map_err(|e| format!("Server error: {}", e))?;

        Ok(())
    }
}

fn build_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
}

fn generate_self_signed_cert(port: u16) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| format!("Failed to generate key pair: {}", e))?;

    let mut params = rcgen::CertificateParams::new(vec![
        "localhost".to_string(),
    ]).map_err(|e| format!("Failed to create certificate params: {}", e))?;

    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, "Termul Web");
    params.distinguished_name.push(rcgen::DnType::OrganizationName, "Termul");
    params.not_before = time::OffsetDateTime::now_utc();
    params.not_after = time::OffsetDateTime::now_utc()
        .checked_add(time::Duration::days(365))
        .unwrap();

    let cert = params.self_signed(&key_pair)
        .map_err(|e| format!("Failed to self-sign certificate: {}", e))?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::try_from(key_pair.serialize_der())
        .map_err(|e| format!("Failed to convert private key: {}", e))?;

    log::info!("[WsServer] Generated self-signed ECDSA P-256 certificate for localhost:{}", port);
    Ok((vec![cert_der], key_der))
}

#[allow(dead_code)]
fn build_tls_config(certs: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> Result<Arc<ServerConfig>, String> {
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Failed to build TLS config: {}", e))?;

    Ok(Arc::new(config))
}

fn get_index_html() -> &'static str {
    r##"<!doctype html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Termul Web - Remote Terminal</title>
    <meta name="theme-color" content="#1E1E2E" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #1e1e2e; color: #cdd6f4; font-family: system-ui, sans-serif; }
        #root { height: 100vh; display: flex; flex-direction: column; }
        .header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #181825; border-bottom: 1px solid #313244; }
        .header h1 { font-size: 16px; font-weight: 600; }
        .header-controls { display: flex; align-items: center; gap: 12px; }
        .tab-bar { display: flex; gap: 2px; padding: 4px 20px 0; background: #181825; border-bottom: 1px solid #313244; }
        .tab { padding: 8px 16px; background: #1e1e2e; border: 1px solid #313244; border-bottom: none; border-radius: 6px 6px 0 0; cursor: pointer; font-size: 12px; color: #a6adc8; display: flex; align-items: center; gap: 8px; }
        .tab.active { background: #313244; color: #cdd6f4; }
        .tab:hover { background: #45475a; }
        .tab-close { width: 14px; height: 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; opacity: 0.5; }
        .tab-close:hover { opacity: 1; background: #f38ba8; color: #1e1e2e; }
        .add-tab { padding: 8px 12px; cursor: pointer; font-size: 16px; color: #a6adc8; background: none; border: none; }
        .add-tab:hover { color: #89b4fa; }
        .status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #a6adc8; }
        .dot { width: 8px; height: 8px; border-radius: 50%; }
        .dot.green { background: #a6e3a1; animation: pulse 2s infinite; }
        .dot.red { background: #f38ba8; }
        .dot.yellow { background: #f9e2af; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .terminal-container { flex: 1; padding: 4px; display: none; }
        .terminal-container.active { display: block; }
        #terminal { width: 100%; height: 100%; }
        .connecting { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; }
        .spinner { width: 40px; height: 40px; border: 3px solid #313244; border-top-color: #89b4fa; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { color: #f38ba8; font-size: 14px; text-align: center; padding: 20px; }
        .retry-btn { padding: 8px 20px; background: #89b4fa; color: #1e1e2e; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
        .retry-btn:hover { background: #74c7ec; }
        .token-expiry { font-size: 11px; color: #6c7086; }
        .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; background: #313244; border-radius: 8px; font-size: 13px; animation: slideIn 0.3s ease; z-index: 1000; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    </style>
</head>
<body>
    <div id="root">
        <div class="connecting" id="loading">
            <div class="spinner"></div>
            <p>Connecting to Termul server...</p>
        </div>
    </div>
    <script type="module">
        // Jika diakses lewat Cloudflare Tunnel (https://*.trycloudflare.com), browser akan melihat protokol https,
        // sehingga WebSocket harus dipaksa menggunakan wss:// agar tidak diblokir oleh mixed content policy.
        let wsProto = "ws://";
        if (window.location.protocol === "https:" || window.location.hostname.endsWith("trycloudflare.com")) {
            wsProto = "wss://";
        }
        
        // Cek jika link di-route lewat Cloudflare Tunnel, port local (:9876) tidak boleh dimasukkan karena port HTTPS Cloudflare
        // adalah standard 443. Jika localhost / IP local biasa, port wajib ada.
        let wsHost = window.location.host;
        if (window.location.hostname.endsWith("trycloudflare.com")) {
            wsHost = window.location.hostname;
        }
        
        const WS_URL = wsProto + wsHost + "/ws";
        const WS_TOKEN = "__TERMUL_TOKEN__";
        const TOKEN_EXPIRES_AT = parseInt("__TERMUL_TOKEN_EXPIRES__") || 0;

        let terminals = [];
        let activeTerminalId = null;
        let ws = null;
        let pendingRequests = new Map();
        let eventListeners = new Map();
        let reconnectAttempts = 0;
        let maxReconnectAttempts = 10;
        let sessionTerminals = null;

        try {
            const saved = sessionStorage.getItem("termul-terminals");
            if (saved) sessionTerminals = JSON.parse(saved);
        } catch {}

        function generateId() {
            return "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
        }

        function invoke(method, params) {
            return new Promise((resolve, reject) => {
                const id = generateId();
                const timeout = setTimeout(() => {
                    pendingRequests.delete(id);
                    reject(new Error("Request timeout: " + method));
                }, 30000);
                pendingRequests.set(id, { resolve, reject, timeout });
                ws.send(JSON.stringify({ type: "request", id, method, params }));
            });
        }

        function listen(event, callback) {
            if (!eventListeners.has(event)) eventListeners.set(event, []);
            eventListeners.get(event).push(callback);
            return () => {
                const listeners = eventListeners.get(event);
                if (listeners) {
                    const idx = listeners.indexOf(callback);
                    if (idx >= 0) listeners.splice(idx, 1);
                }
            };
        }

        function emitEvent(eventName, payload) {
            const listeners = eventListeners.get(eventName);
            if (listeners) {
                for (const cb of listeners) cb(payload);
            }
        }

        async function connect() {
            return new Promise((resolve, reject) => {
                console.log("Connecting to WebSocket URL:", WS_URL);
                ws = new WebSocket(WS_URL);
                
                const timeout = setTimeout(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        console.error("WebSocket connection timed out");
                        ws.close();
                        reject(new Error("Connection timeout"));
                    }
                }, 30000); // 30s timeout to allow cold tunnel connections

                ws.onopen = () => {
                    console.log("WebSocket connection opened. Sending auth token...");
                    ws.send(JSON.stringify({ type: "auth", token: WS_TOKEN }));
                };

                ws.onmessage = async (event) => {
                    console.log("WebSocket received message:", event.data);
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === "response") {
                            if (msg.id === "auth") {
                                clearTimeout(timeout);
                                if (msg.success) {
                                    console.log("WebSocket authenticated successfully");
                                    reconnectAttempts = 0;
                                    resolve();
                                } else {
                                    console.error("WebSocket auth failed:", msg.error);
                                    reject(new Error(msg.error || "Auth failed"));
                                }
                            } else {
                                const pending = pendingRequests.get(msg.id);
                                if (pending) {
                                    clearTimeout(pending.timeout);
                                    pendingRequests.delete(msg.id);
                                    if (msg.success) pending.resolve(msg.data);
                                    else pending.reject(new Error(msg.error || "Unknown error"));
                                }
                            }
                        } else if (msg.type === "event") {
                            emitEvent(msg.event, msg.payload || {});
                        }
                    } catch (e) {
                        console.error("Error processing websocket message:", e);
                    }
                };

                ws.onclose = (event) => {
                    console.warn("WebSocket connection closed:", event);
                    for (const [, p] of pendingRequests) {
                        clearTimeout(p.timeout);
                        p.reject(new Error("Disconnected"));
                    }
                    pendingRequests.clear();
                    if (reconnectAttempts < maxReconnectAttempts) {
                        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                        reconnectAttempts++;
                        console.log(`Reconnecting in ${delay}ms (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
                        setTimeout(() => connect().then(resolve).catch(reject), delay);
                    } else {
                        reject(new Error("Max reconnect attempts reached"));
                    }
                };

                ws.onerror = (error) => {
                    console.error("WebSocket error observed:", error);
                };
            });
        }

        async function loadXterm() {
            const xtermModule = await import("https://esm.sh/@xterm/xterm@5.5.0");
            const fitModule = await import("https://esm.sh/@xterm/addon-fit@0.12.0-beta.216");
            const webLinksModule = await import("https://esm.sh/@xterm/addon-web-links@0.11.0");
            return { Terminal: xtermModule.Terminal, FitAddon: fitModule.FitAddon, WebLinksAddon: webLinksModule.WebLinksAddon };
        }

        async function initTerminal(terminalObj, isRestore = false) {
            const { Terminal, FitAddon, WebLinksAddon } = await loadXterm();

            const term = new Terminal({
                cursorBlink: true,
                fontSize: 14,
                fontFamily: "monospace",
                theme: {
                    background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
                    selectionBackground: "#585b7066",
                    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
                    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
                    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
                    brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
                    brightCyan: "#94e2d5", brightWhite: "#a6adc8",
                },
            });

            const fitAddon = new FitAddon();
            const webLinksAddon = new WebLinksAddon();
            term.loadAddon(fitAddon);
            term.loadAddon(webLinksAddon);

            const container = document.getElementById("term-" + terminalObj.id);
            term.open(container);
            fitAddon.fit();

            terminalObj.term = term;
            terminalObj.fitAddon = fitAddon;

            term.onData((data) => {
                if (terminalObj.remoteId) invoke("terminal_write", { terminalId: terminalObj.remoteId, data }).catch(() => {});
            });

            term.onResize(({ cols, rows }) => {
                if (terminalObj.remoteId) invoke("terminal_resize", { terminalId: terminalObj.remoteId, cols, rows }).catch(() => {});
            });

            term.attachCustomKeyEventHandler((ev) => {
                if (ev.type === "keydown" && ev.ctrlKey && ev.shiftKey) {
                    if (ev.key === "c" || ev.key === "C") {
                        const text = term.getSelection();
                        if (text) {
                            navigator.clipboard.writeText(text).catch(() => {});
                            showToast("Copied to clipboard");
                            return false;
                        }
                    }
                    if (ev.key === "v" || ev.key === "V") {
                        navigator.clipboard.readText().then(text => {
                            if (terminalObj.remoteId) invoke("terminal_write", { terminalId: terminalObj.remoteId, data: text }).catch(() => {});
                        }).catch(() => {});
                        return false;
                    }
                }
                return true;
            });

            listen("terminal-data", (payload) => {
                if (payload.terminalId === terminalObj.remoteId) term.write(payload.data || "");
            });

            listen("terminal-exit", (payload) => {
                if (payload.terminalId === terminalObj.remoteId) {
                    term.write("\r\n\x1b[33mProcess exited.\x1b[0m\r\n");
                }
            });

            listen("terminal-cwd-changed", () => {});
            listen("terminal-git-branch-changed", () => {});
            listen("terminal-git-status-changed", () => {});
            listen("terminal-exit-code-changed", () => {});

            if (isRestore && terminalObj.remoteId) {
                term.write("\r\n\x1b[33mSession restored. Terminal ID: " + terminalObj.remoteId + "\x1b[0m\r\n");
            } else {
                const result = await invoke("terminal_spawn", {});
                if (result.success) {
                    terminalObj.remoteId = result.data.id;
                    saveSession();
                } else {
                    term.write("\r\n\x1b[31mFailed to spawn terminal: " + (result.error || "Unknown") + "\x1b[0m\r\n");
                }
            }
        }

        async function addTerminal() {
            const id = "tab-" + Date.now();
            const terminalObj = { id, remoteId: null, term: null, fitAddon: null };
            terminals.push(terminalObj);
            renderTabs();
            await createTerminalContainer(terminalObj);
            setActiveTerminal(id);
            await initTerminal(terminalObj);
            saveSession();
        }

        async function createTerminalContainer(terminalObj) {
            const root = document.getElementById("root");
            const container = document.createElement("div");
            container.className = "terminal-container";
            container.id = "term-" + terminalObj.id;
            const header = root.querySelector(".header");
            const tabBar = root.querySelector(".tab-bar");
            if (tabBar) {
                tabBar.after(container);
            } else {
                header.after(container);
            }
        }

        function renderTabs() {
            const root = document.getElementById("root");
            let tabBar = root.querySelector(".tab-bar");
            if (!tabBar) {
                tabBar = document.createElement("div");
                tabBar.className = "tab-bar";
                const header = root.querySelector(".header");
                header.after(tabBar);
            }
            tabBar.innerHTML = terminals.map(t =>
                "<div class='tab" + (t.id === activeTerminalId ? " active" : "") + "' data-id='" + t.id + "'>" +
                "<span>Terminal</span>" +
                "<div class='tab-close' data-close='" + t.id + "'>x</div>" +
                "</div>"
            ).join("") + "<button class='add-tab' id='add-tab'>+</button>";

            tabBar.querySelectorAll(".tab").forEach(el => {
                el.addEventListener("click", (e) => {
                    if (!e.target.classList.contains("tab-close")) {
                        setActiveTerminal(el.dataset.id);
                    }
                });
            });

            tabBar.querySelectorAll(".tab-close").forEach(el => {
                el.addEventListener("click", (e) => {
                    e.stopPropagation();
                    closeTerminal(el.dataset.close);
                });
            });

            document.getElementById("add-tab").addEventListener("click", () => addTerminal());
        }

        function setActiveTerminal(id) {
            activeTerminalId = id;
            document.querySelectorAll(".terminal-container").forEach(el => el.classList.remove("active"));
            const container = document.getElementById("term-" + id);
            if (container) container.classList.add("active");
            const terminalObj = terminals.find(t => t.id === id);
            if (terminalObj && terminalObj.fitAddon) {
                setTimeout(() => terminalObj.fitAddon.fit(), 50);
            }
            renderTabs();
        }

        function closeTerminal(id) {
            const idx = terminals.findIndex(t => t.id === id);
            if (idx === -1) return;
            const terminalObj = terminals[idx];
            if (terminalObj.term) {
                terminalObj.term.dispose();
            }
            const container = document.getElementById("term-" + id);
            if (container) container.remove();
            terminals.splice(idx, 1);
            if (activeTerminalId === id) {
                if (terminals.length > 0) {
                    setActiveTerminal(terminals[Math.max(0, idx - 1)].id);
                } else {
                    activeTerminalId = null;
                }
            }
            saveSession();
            renderTabs();
        }

        function saveSession() {
            try {
                const data = terminals.map(t => ({ id: t.id, remoteId: t.remoteId }));
                sessionStorage.setItem("termul-terminals", JSON.stringify(data));
            } catch {}
        }

        function showToast(msg) {
            const toast = document.createElement("div");
            toast.className = "toast";
            toast.textContent = msg;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
        }

        async function start() {
            try {
                await connect();
                const root = document.getElementById("root");
                root.innerHTML = "<div class='header'>" +
                    "<h1>Termul Web</h1>" +
                    "<div class='header-controls'>" +
                    "<span class='token-expiry' id='token-expiry'></span>" +
                    "<div class='status'><div class='dot green'></div><span>Connected</span></div>" +
                    "</div>" +
                    "</div>" +
                    "<div class='tab-bar'></div>";

                if (TOKEN_EXPIRES_AT > 0) {
                    const expiryEl = document.getElementById("token-expiry");
                    const updateExpiry = () => {
                        const remaining = TOKEN_EXPIRES_AT - Math.floor(Date.now() / 1000);
                        if (remaining > 0) {
                            const mins = Math.floor(remaining / 60);
                            const secs = remaining % 60;
                            expiryEl.textContent = "Token: " + mins + "m " + secs + "s";
                        } else {
                            expiryEl.textContent = "Token expired";
                        }
                    };
                    updateExpiry();
                    setInterval(updateExpiry, 1000);
                }

                if (sessionTerminals && sessionTerminals.length > 0) {
                    for (const saved of sessionTerminals) {
                        const terminalObj = { id: saved.id, remoteId: saved.remoteId, term: null, fitAddon: null };
                        terminals.push(terminalObj);
                        await createTerminalContainer(terminalObj);
                    }
                    renderTabs();
                    if (terminals.length > 0) setActiveTerminal(terminals[0].id);
                    for (const t of terminals) {
                        await initTerminal(t, true);
                    }
                } else {
                    await addTerminal();
                }
            } catch (err) {
                const root = document.getElementById("root");
                root.innerHTML = "<div class='error'>" +
                    "<h2>Connection Failed</h2>" +
                    "<p>" + (err.message || "Cannot connect to server") + "</p>" +
                    "<p style='font-size:12px;color:#a6adc8;margin-top:8px'>Attempt " + (reconnectAttempts + 1) + "/" + maxReconnectAttempts + "</p>" +
                    "<button class='retry-btn' onclick='location.reload()'>Retry</button>" +
                    "</div>";
            }
        }

        window.addEventListener("resize", () => {
            const terminalObj = terminals.find(t => t.id === activeTerminalId);
            if (terminalObj && terminalObj.fitAddon) terminalObj.fitAddon.fit();
        });

        start();
    </script>
</body>
</html>"##
}

async fn shutdown_signal(server: Arc<WsServer>) {
    while server.running.load(Ordering::SeqCst) {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

async fn handle_ws(
    socket: WebSocket,
    server: Arc<WsServer>,
    auth_token: String,
    app_handle: AppHandle,
    addr: SocketAddr,
) {
    let (ws_write, mut ws_read) = socket.split();

    let client_id = format!("{}-{}", addr.ip(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsOutbound>();

    {
        let mut clients = server.clients.lock().await;
        clients.insert(client_id.clone(), WsClient {
            authenticated: false,
            tx: tx.clone(),
            connected_at: Instant::now(),
        });
        let mut status = server.status.lock().await;
        status.client_count = clients.len();
    }

    let mut event_rx = server.event_tx.subscribe();

    let write_task = tokio::spawn(async move {
        let mut ws_write = ws_write;
        loop {
            tokio::select! {
                Some(msg) = rx.recv() => {
                    let send_result = match msg {
                        WsOutbound::Pong(data) => ws_write.send(Message::Pong(data)).await,
                        other => {
                            if let Ok(text) = serde_json::to_string(&other) {
                                ws_write.send(Message::Text(text)).await
                            } else {
                                break;
                            }
                        }
                    };
                    if send_result.is_err() {
                        break;
                    }
                }
                Ok(event) = event_rx.recv() => {
                    if let Ok(text) = serde_json::to_string(&event) {
                        if ws_write.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                }
                else => break,
            }
        }
    });

    while let Some(Ok(msg)) = ws_read.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsInbound>(&text) {
                    match ws_msg {
                        WsInbound::Auth { token } => {
                            let success = token == auth_token;
                            let resp = if success {
                                let mut clients = server.clients.lock().await;
                                if let Some(client) = clients.get_mut(&client_id) {
                                    client.authenticated = true;
                                }
                                server.log_connection(&addr, "authenticated");
                                WsOutbound::Response {
                                    id: "auth".to_string(),
                                    success: true,
                                    data: None,
                                    error: None,
                                    code: None,
                                }
                            } else {
                                server.log_connection(&addr, "auth_failed");
                                WsOutbound::Response {
                                    id: "auth".to_string(),
                                    success: false,
                                    data: None,
                                    error: Some("Invalid auth token".to_string()),
                                    code: Some("AUTH_FAILED".to_string()),
                                }
                            };
                            let _ = tx.send(resp);
                            if !success {
                                log::warn!("[WsServer] Auth failed for {}", addr);
                                break;
                            }
                            log::info!("[WsServer] WS client authenticated: {}", addr);
                        }
                        WsInbound::Request { id, method, params } => {
                            let is_authenticated = {
                                let clients = server.clients.lock().await;
                                clients.get(&client_id).map(|c| c.authenticated).unwrap_or(false)
                            };

                            if !is_authenticated {
                                let _ = tx.send(WsOutbound::Response {
                                    id,
                                    success: false,
                                    data: None,
                                    error: Some("Not authenticated".to_string()),
                                    code: Some("NOT_AUTHENTICATED".to_string()),
                                });
                                continue;
                            }

                            let result = handle_command(&method, params, &app_handle, &server).await;
                            let resp = match result {
                                Ok(ipc_result) => {
                                    if ipc_result.success {
                                        WsOutbound::Response {
                                            id,
                                            success: true,
                                            data: ipc_result.data,
                                            error: None,
                                            code: None,
                                        }
                                    } else {
                                        WsOutbound::Response {
                                            id,
                                            success: false,
                                            data: None,
                                            error: ipc_result.error,
                                            code: ipc_result.code,
                                        }
                                    }
                                }
                                Err(e) => WsOutbound::Response {
                                    id,
                                    success: false,
                                    data: None,
                                    error: Some(e),
                                    code: Some("COMMAND_ERROR".to_string()),
                                },
                            };
                            let _ = tx.send(resp);
                        }
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(data) => {
                let _ = tx.send(WsOutbound::Pong(data.to_vec()));
            }
            _ => {}
        }
    }

    write_task.abort();

    {
        let mut clients = server.clients.lock().await;
        let client = clients.remove(&client_id);
        let mut status = server.status.lock().await;
        status.client_count = clients.len();
        if let Some(c) = client {
            let duration = c.connected_at.elapsed();
            log::info!("[WsServer] Client {} disconnected after {:.1}s", addr, duration.as_secs_f64());
            server.log_connection(&addr, "disconnected");
        }
    }
}

async fn handle_command(
    method: &str,
    params: Option<serde_json::Value>,
    app_handle: &AppHandle,
    server: &Arc<WsServer>,
) -> Result<IpcResult<serde_json::Value>, String> {
    match method {
        "terminal_spawn" => {
            let options: SpawnOptions = params
                .map(|p| serde_json::from_value(p))
                .transpose()
                .map_err(|e| format!("Invalid params: {}", e))?
                .unwrap_or_default();

            let pty_manager = app_handle.state::<Arc<PtyManager>>();
            match pty_manager.spawn(options).await {
                Ok(info) => Ok(IpcResult::success(serde_json::to_value(&info).map_err(|e| e.to_string())?)),
                Err(e) => Ok(IpcResult::error(e, "SPAWN_FAILED")),
            }
        }
        "terminal_write" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;
            let data: String = serde_json::from_value(params["data"].clone())
                .map_err(|e| format!("Invalid data: {}", e))?;

            let pty_manager = app_handle.state::<Arc<PtyManager>>();
            match pty_manager.write(&terminal_id, &data).await {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e, "WRITE_FAILED")),
            }
        }
        "terminal_resize" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;
            let cols: u16 = serde_json::from_value(params["cols"].clone())
                .map_err(|e| format!("Invalid cols: {}", e))?;
            let rows: u16 = serde_json::from_value(params["rows"].clone())
                .map_err(|e| format!("Invalid rows: {}", e))?;

            let pty_manager = app_handle.state::<Arc<PtyManager>>();
            match pty_manager.resize(&terminal_id, cols, rows).await {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e, "RESIZE_FAILED")),
            }
        }
        "terminal_kill" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let pty_manager = app_handle.state::<Arc<PtyManager>>();
            match pty_manager.kill(&terminal_id).await {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e, "KILL_FAILED")),
            }
        }
        "terminal_get_cwd" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let cwd_tracker = app_handle.state::<Arc<CwdTracker>>();
            let cwd = cwd_tracker.get_cwd(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&cwd).map_err(|e| e.to_string())?))
        }
        "terminal_get_git_branch" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let git_tracker = app_handle.state::<Arc<GitTracker>>();
            let branch = git_tracker.get_branch(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&branch).map_err(|e| e.to_string())?))
        }
        "terminal_get_git_status" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let git_tracker = app_handle.state::<Arc<GitTracker>>();
            let status = git_tracker.get_status(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&status).map_err(|e| e.to_string())?))
        }
        "terminal_get_exit_code" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let exit_code_tracker = app_handle.state::<Arc<ExitCodeTracker>>();
            let exit_code = exit_code_tracker.get_exit_code(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&exit_code).map_err(|e| e.to_string())?))
        }
        "terminal_clipboard_write" => {
            let params = params.ok_or("Missing params")?;
            let text: String = serde_json::from_value(params["text"].clone())
                .map_err(|e| format!("Invalid text: {}", e))?;

            use tauri_plugin_clipboard_manager::ClipboardExt;
            match app_handle.clipboard().write_text(&text) {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e.to_string(), "CLIPBOARD_WRITE_FAILED")),
            }
        }
        "terminal_clipboard_read" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            match app_handle.clipboard().read_text() {
                Ok(text) => Ok(IpcResult::success(serde_json::json!({ "text": text }))),
                Err(e) => Ok(IpcResult::error(e.to_string(), "CLIPBOARD_READ_FAILED")),
            }
        }
        "tunnel_start" => {
            let config = params.ok_or("Missing params")?;
            let tunnel_config: crate::tunnel::TunnelConfig =
                serde_json::from_value(config).map_err(|e| e.to_string())?;
            let result = crate::tunnel::tunnel_start(tunnel_config, app_handle.clone()).await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "tunnel_stop" => {
            let params = params.ok_or("Missing params")?;
            let tunnel_id: String = serde_json::from_value(params["tunnelId"].clone())
                .map_err(|e| format!("Invalid tunnelId: {}", e))?;
            let result = crate::tunnel::tunnel_stop(tunnel_id, app_handle.clone()).await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "tunnel_list" => {
            let result = crate::tunnel::tunnel_list().await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "ws_get_audit_log" => {
            let audit_log = server.get_audit_log().await;
            Ok(IpcResult::success(serde_json::to_value(&audit_log).map_err(|e| e.to_string())?))
        }
        "ws_rotate_token" => {
            let new_token = server.rotate_token().await;
            Ok(IpcResult::success(serde_json::json!({ "token": new_token })))
        }
        other => {
            Ok(IpcResult::error(format!("Unknown method: {}", other), "METHOD_NOT_FOUND"))
        }
    }
}

async fn is_port_in_use(port: u16) -> bool {
    tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .is_ok()
}

fn get_local_ip() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}
