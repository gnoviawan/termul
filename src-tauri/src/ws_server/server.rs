use super::{WsServer, WsServerStatus};
use super::{WsOutbound, ConnectionAudit};
use crate::ws_server::html::get_index_html;
use crate::ws_server::utils::{is_port_in_use, get_local_ip};
use axum::{
    Router,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    extract::{Request, State},
    response::{Html, IntoResponse, Response},
    routing::get,
    middleware::{self, Next},
};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use crate::ws_server::handler::{ws_handler, shutdown_signal};
use crate::ws_server::utils::generate_self_signed_cert;
use base64::Engine;

async fn basic_auth_guard(
    State(state): State<super::AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let connection_context = state.server.get_connection_context().await;
    let expected_token = connection_context.0;

    let authorized = is_basic_auth_valid(headers.get(header::AUTHORIZATION), &expected_token);

    if authorized {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Basic realm=\"Termul Web\"")], "Authentication required").into_response()
    }
}

async fn http_route_handler(State(state): State<super::AppState>) -> impl axum::response::IntoResponse {
    index_handler(State(state)).await
}

fn session_cookie_header(token: &str, ttl_secs: u64, secure: bool) -> Option<HeaderValue> {
    let value = format!(
        "termul_web_lite_password={}; Path=/; Max-Age={}; SameSite=Lax; HttpOnly{}",
        token,
        ttl_secs,
        if secure { "; Secure" } else { "" }
    );
    HeaderValue::from_str(&value).ok()
}

fn allowed_origins(port: u16) -> [HeaderValue; 4] {
    [
        HeaderValue::from_str(&format!("http://localhost:{}", port)).unwrap(),
        HeaderValue::from_str(&format!("http://127.0.0.1:{}", port)).unwrap(),
        HeaderValue::from_str(&format!("https://localhost:{}", port)).unwrap(),
        HeaderValue::from_str(&format!("https://127.0.0.1:{}", port)).unwrap(),
    ]
}

fn is_basic_auth_valid(header_value: Option<&HeaderValue>, expected_token: &str) -> bool {
    header_value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "))
        .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
        .and_then(|decoded| String::from_utf8(decoded).ok())
        .map(|credentials| credentials.rsplit_once(':').map(|(_, password)| password == expected_token).unwrap_or(false))
        .unwrap_or(false)
}

pub(crate) async fn index_handler(State(state): State<super::AppState>) -> Response {
    let connection_context = state.server.get_connection_context().await;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let token_expired = now >= connection_context.1 + connection_context.2;
    let connection_context = if token_expired {
        log::warn!("[WsServer] Token expired, generating new one");
        let _ = state.server.rotate_token().await;
        state.server.get_connection_context().await
    } else {
        connection_context
    };
    let html = state.index_html
        .replace("__TERMUL_TOKEN__", &connection_context.0)
        .replace("__TERMUL_TOKEN_EXPIRES__", &(connection_context.1 + connection_context.2).to_string())
        .replace("__TERMUL_SESSION_ID__", &connection_context.3)
        .replace("__TERMUL_ACTIVE_PROJECT_ID__", connection_context.4.as_deref().unwrap_or(""));
    let mut response = Html(html).into_response();
    if let Some(cookie) = session_cookie_header(&connection_context.0, connection_context.2, state.server.get_status().await.use_https) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

impl WsServer {
    pub fn new() -> Self {
        let (event_tx, _) = tokio::sync::broadcast::channel(2048);
        let initial_token = Self::generate_token();
        let initial_session_id = Self::generate_session_id();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        Self {
            config: tokio::sync::Mutex::new(None),
            status: tokio::sync::Mutex::new(WsServerStatus {
                is_running: false,
                port: 9876,
                client_count: 0,
                session_id: initial_session_id.clone(),
                active_project_id: None,
                token_ttl_secs: super::DEFAULT_TOKEN_TTL_SECS,
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
            session_id: tokio::sync::Mutex::new(initial_session_id),
            token_created_at: std::sync::atomic::AtomicU64::new(now),
            token_ttl_secs: std::sync::atomic::AtomicU64::new(super::DEFAULT_TOKEN_TTL_SECS),
            auth_attempts: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            active_project: tokio::sync::Mutex::new(None),
            active_project_id: tokio::sync::Mutex::new(None),
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

    pub fn generate_session_id() -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..24).map(|_| rng.sample(rand::distributions::Alphanumeric) as char).collect()
    }

    pub async fn rotate_token(&self) -> String {
        let new_token = Self::generate_token();
        let new_session_id = Self::generate_session_id();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let mut token = self.current_token.lock().await;
        *token = new_token.clone();
        *self.session_id.lock().await = new_session_id.clone();
        self.token_created_at.store(now, Ordering::SeqCst);
        let active_project_id = self.active_project_id.lock().await.clone();
        let token_ttl_secs = self.token_ttl_secs.load(Ordering::SeqCst);
        let mut status = self.status.lock().await;
        status.session_id = new_session_id;
        status.active_project_id = active_project_id;
        status.token_ttl_secs = token_ttl_secs;
        log::info!("[WsServer] Token rotated");
        new_token
    }

    pub async fn get_connection_context(&self) -> (String, u64, u64, String, Option<String>) {
        let token = self.current_token.lock().await.clone();
        let session_id = self.session_id.lock().await.clone();
        let created = self.token_created_at.load(Ordering::SeqCst);
        let ttl = self.token_ttl_secs.load(Ordering::SeqCst);
        let active_project_id = self.active_project_id.lock().await.clone();
        (token, created, ttl, session_id, active_project_id)
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
        let project_binding = format!("{}::{}", name, path);
        *active_proj = Some(super::ActiveProjectInfo {
            name,
            path,
            default_shell,
            color,
        });
        {
            let mut active_project_id = self.active_project_id.lock().await;
            *active_project_id = Some(project_binding);
        }
        let _ = self.rotate_token().await;
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
                let mut active_project_id_lock = self.active_project_id.lock().await;
                *active_project_id_lock = Some(proj.id.clone());
            } else {
                let mut active_project_id_lock = self.active_project_id.lock().await;
                *active_project_id_lock = active_project_id.clone();
            }
        } else {
            let mut active_project_id_lock = self.active_project_id.lock().await;
            *active_project_id_lock = None;
        }

        drop(active_proj);
        drop(projs);
        let _ = self.rotate_token().await;

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
        *self.session_id.lock().await = Self::generate_session_id();
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
        let session_id = self.session_id.lock().await.clone();
        let active_project_id = self.active_project_id.lock().await.clone();
        let token_ttl_secs = self.token_ttl_secs.load(Ordering::SeqCst);

        let mut status = self.status.lock().await;
        status.is_running = true;
        status.port = port;
        status.http_url = format!("{}://localhost:{}", scheme, port);
        status.ws_url = format!("{}://localhost:{}", ws_scheme, port);
        status.use_https = use_https;
        status.session_id = session_id;
        status.active_project_id = active_project_id;
        status.token_ttl_secs = token_ttl_secs;

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
        let session_id = self.session_id.lock().await.clone();
        let active_project_id = self.active_project_id.lock().await.clone();
        let token_ttl_secs = self.token_ttl_secs.load(Ordering::SeqCst);
        let status = self.status.lock().await;
        let mut cloned = status.clone();
        cloned.session_id = session_id;
        cloned.active_project_id = active_project_id;
        cloned.token_ttl_secs = token_ttl_secs;
        cloned
    }

    async fn run_server(
        self: Arc<Self>,
        app_handle: AppHandle,
        port: u16,
        _auth_token: String,
        use_https: bool,
    ) -> Result<(), String> {
        let cors = tower_http::cors::CorsLayer::new()
            .allow_origin(allowed_origins(port))
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any);
        let index_html = get_index_html();

        let app_state = super::AppState {
            index_html: index_html.to_string(),
            app_handle: app_handle.clone(),
            server: self.clone(),
        };

        let ws_app = Router::new().route("/ws", get(ws_handler));
        let http_app = Router::new()
            .route("/", get(http_route_handler))
            .fallback(get(http_route_handler))
            .layer(middleware::from_fn_with_state(app_state.clone(), basic_auth_guard));

        let app = ws_app
            .merge(http_app)
            .layer(cors)
            .with_state(app_state);

        let addr = SocketAddr::from(([127, 0, 0, 1], port));

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

#[cfg(test)]
mod tests {
    use super::{is_basic_auth_valid, session_cookie_header, WsServer};
    use axum::http::HeaderValue;
    use base64::Engine;

    #[test]
    fn generated_credentials_have_expected_lengths() {
        assert_eq!(WsServer::generate_token().len(), 32);
        assert_eq!(WsServer::generate_session_id().len(), 24);
    }

    #[tokio::test]
    async fn rotating_token_also_rotates_session_context() {
        let server = WsServer::new();
        let before = server.get_connection_context().await.3;
        let token = server.rotate_token().await;
        let after = server.get_connection_context().await.3;

        assert_eq!(token.len(), 32);
        assert_ne!(before, after);
    }

    #[test]
    fn session_cookie_has_expected_shape() {
        let cookie = session_cookie_header("secret-token", 900, false).expect("cookie header");
        let value = cookie.to_str().expect("cookie str");

        assert!(value.contains("termul_web_lite_password=secret-token"));
        assert!(value.contains("Path=/"));
        assert!(value.contains("Max-Age=900"));
        assert!(value.contains("SameSite=Lax"));
        assert!(value.contains("HttpOnly"));
        assert!(!value.contains("Secure"));
    }

    #[test]
    fn secure_cookie_adds_secure_flag() {
        let cookie = session_cookie_header("secret-token", 900, true).expect("cookie header");
        let value = cookie.to_str().expect("cookie str");

        assert!(value.contains("HttpOnly"));
        assert!(value.contains("Secure"));
    }

    #[test]
    fn allowed_origins_are_localhost_only() {
        let origins = super::allowed_origins(9876);
        let rendered = origins
            .iter()
            .map(|value| value.to_str().expect("origin str"))
            .collect::<Vec<_>>();

        assert_eq!(rendered, vec![
            "http://localhost:9876",
            "http://127.0.0.1:9876",
            "https://localhost:9876",
            "https://127.0.0.1:9876",
        ]);
    }

    #[test]
    fn basic_auth_validation_accepts_and_rejects() {
        let valid = HeaderValue::from_str(
            &format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("user:secret-token")
            )
        ).expect("valid header");
        let invalid = HeaderValue::from_str(
            &format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("user:wrong-token")
            )
        ).expect("invalid header");

        assert!(is_basic_auth_valid(Some(&valid), "secret-token"));
        assert!(!is_basic_auth_valid(Some(&invalid), "secret-token"));
        assert!(!is_basic_auth_valid(None, "secret-token"));
    }
}
