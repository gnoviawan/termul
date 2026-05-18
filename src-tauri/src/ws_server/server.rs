use super::{WsServer, WsServerStatus};
use super::{WsOutbound, ConnectionAudit};
use crate::ws_server::html::get_index_html;
use crate::ws_server::utils::{is_port_in_use, get_local_ip};
use axum::{
    Router,
    extract::State,
    response::Html,
    routing::get,
};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use crate::ws_server::handler::{ws_handler, shutdown_signal};
use crate::ws_server::utils::generate_self_signed_cert;

pub(crate) async fn index_handler(State(state): State<super::AppState>) -> impl axum::response::IntoResponse {
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

impl WsServer {
    pub fn new() -> Self {
        let (event_tx, _) = tokio::sync::broadcast::channel(2048);
        let initial_token = Self::generate_token();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        Self {
            config: tokio::sync::Mutex::new(None),
            status: tokio::sync::Mutex::new(WsServerStatus {
                is_running: false,
                port: 9876,
                client_count: 0,
                http_url: String::new(),
                ws_url: String::new(),
                use_https: false,
            }),
            clients: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            event_tx,
            running: std::sync::atomic::AtomicBool::new(false),
            self_weak: std::sync::Mutex::new(None),
            audit_log: tokio::sync::Mutex::new(Vec::new()),
            current_token: tokio::sync::Mutex::new(initial_token),
            token_created_at: std::sync::atomic::AtomicU64::new(now),
            token_ttl_secs: std::sync::atomic::AtomicU64::new(super::DEFAULT_TOKEN_TTL_SECS),
            auth_attempts: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            active_project: tokio::sync::Mutex::new(None),
            projects: tokio::sync::Mutex::new(Vec::new()),
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

    pub async fn set_active_project(&self, name: String, path: String, default_shell: Option<String>, color: Option<String>) {
        let mut active_proj = self.active_project.lock().await;
        *active_proj = Some(super::ActiveProjectInfo {
            name,
            path,
            default_shell,
            color,
        });
    }

    pub async fn set_projects(&self, projects: Vec<super::ProjectInfo>, active_project_id: Option<String>) {
        let mut projs = self.projects.lock().await;
        *projs = projects.clone();

        let mut active_proj = self.active_project.lock().await;
        if let Some(active_id) = &active_project_id {
            if let Some(proj) = projs.iter().find(|p| p.id == *active_id) {
                *active_proj = Some(super::ActiveProjectInfo {
                    name: proj.name.clone(),
                    path: proj.path.clone().unwrap_or_default(),
                    default_shell: None,
                    color: Some(proj.color.clone()),
                });
            }
        }

        let event_payload = serde_json::json!({
            "projects": projects,
            "activeProjectId": active_project_id,
        });
        let _ = self.event_tx.send(WsOutbound::Event {
            event: "projects-changed".to_string(),
            payload: Some(event_payload),
        });
    }

    #[expect(dead_code)]
    pub async fn is_rate_limited(&self, addr: &SocketAddr) -> bool {
        let key = addr.ip().to_string();
        let now = Instant::now();
        let mut attempts = self.auth_attempts.lock().await;

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
        let app_handle_for_server = app_handle.clone();
        let app_handle_for_emit = app_handle.clone();
        tokio::spawn(async move {
            if let Err(e) = server.clone().run_server(app_handle_for_server, port, auth_token, use_https).await {
                log::error!("[WsServer] Server error: {}", e);
            }
            server.running.store(false, Ordering::SeqCst);
            let mut status = server.status.lock().await;
            status.is_running = false;
            status.client_count = 0;
            let _ = app_handle_for_emit.emit("ws-server-status-changed", status.clone());
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

        let _ = app_handle.emit("ws-server-status-changed", status.clone());

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
        let cors = tower_http::cors::CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any);
        let index_html = get_index_html();
        let token_info = self.get_token_info().await;

        let app_state = super::AppState {
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
