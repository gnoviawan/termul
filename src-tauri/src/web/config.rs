//! Bind configuration for the standalone `termul-server` HTTP listener.
//!
//! Mirrors `remote::host::RemoteBindMode` so `--host` parsing stays consistent
//! across the desktop-hosted shared-live server and the headless ACP server.
//! Auth/TLS land in Epic 2 — this story owns host/port + the
//! permission-rendezvous timeout.

use std::net::SocketAddr;

/// Which network interface(s) the standalone HTTP server binds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindMode {
    /// `127.0.0.1` — localhost only (default, safest).
    Localhost,
    /// `0.0.0.0` — all interfaces (explicit expose opt-in).
    All,
}

impl BindMode {
    /// Parse a host string into a bind mode.
    ///
    /// Accepts `localhost` / `127.0.0.1` / `loopback` → [`Localhost`], and
    /// `all` / `0.0.0.0` / `any` → [`All`]. Anything else returns `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "localhost" | "127.0.0.1" | "loopback" => Some(Self::Localhost),
            "all" | "0.0.0.0" | "any" => Some(Self::All),
            _ => None,
        }
    }

    /// Address passed to `TcpListener::bind`.
    pub fn bind_addr(self, port: u16) -> SocketAddr {
        match self {
            Self::Localhost => SocketAddr::from(([127, 0, 0, 1], port)),
            Self::All => SocketAddr::from(([0, 0, 0, 0], port)),
        }
    }

    /// Human-readable bind host for logs / CLI help.
    pub fn display_host(self) -> &'static str {
        match self {
            Self::Localhost => "127.0.0.1",
            Self::All => "0.0.0.0",
        }
    }
}

/// Runtime config for [`crate::web::serve`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    /// Per-session event-log capacity (bounded ring; AC4). Default 4096.
    pub event_log_capacity: usize,
    /// Permission-rendezvous timeout in seconds (Story 1.7 / FR14). On expiry
    /// the pending permission resolves as deny (`Cancelled`). Default 60.
    pub permission_timeout_secs: u64,
}

impl ServerConfig {
    /// Resolve the bind mode from [`Self::host`], defaulting unknown hosts to
    /// a parse error at the CLI layer (callers should validate first).
    pub fn bind_mode(&self) -> Option<BindMode> {
        BindMode::parse(&self.host)
    }

    /// Socket address for `TcpListener::bind`.
    ///
    /// Returns `None` when `host` is not a recognized bind mode.
    pub fn bind_addr(&self) -> Option<SocketAddr> {
        self.bind_mode().map(|mode| mode.bind_addr(self.port))
    }

    /// Parse `--host` / `--port` CLI args (defaults: `127.0.0.1:8080`).
    ///
    /// Returns `Err(ParseCliError::Help)` for `-h`/`--help`.
    pub fn from_args<I, S>(args: I) -> Result<Self, ParseCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut host = "127.0.0.1".to_string();
        let mut port: u16 = 8080;
        let mut event_log_capacity: usize = 4096;
        let mut permission_timeout_secs: u64 = 60;

        let mut iter = args.into_iter().peekable();
        while let Some(arg) = iter.next() {
            let arg = arg.as_ref();
            match arg {
                "-h" | "--help" => return Err(ParseCliError::Help),
                "--host" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| ParseCliError::Message("missing value for --host".into()))?;
                    let value = value.as_ref();
                    if BindMode::parse(value).is_none() {
                        return Err(ParseCliError::Message(format!(
                            "invalid --host '{value}': use 127.0.0.1 or 0.0.0.0"
                        )));
                    }
                    host = value.to_string();
                }
                "--port" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| ParseCliError::Message("missing value for --port".into()))?;
                    let parsed = value.as_ref().parse::<u16>().map_err(|_| {
                        ParseCliError::Message(format!("invalid --port '{}'", value.as_ref()))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --port '0': use 1-65535 (0 is OS-ephemeral)".into(),
                        ));
                    }
                    port = parsed;
                }
                "--event-log-capacity" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --event-log-capacity".into())
                    })?;
                    let parsed = value.as_ref().parse::<usize>().map_err(|_| {
                        ParseCliError::Message(format!(
                            "invalid --event-log-capacity '{}': expected a positive integer",
                            value.as_ref()
                        ))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --event-log-capacity '0': use a positive integer".into(),
                        ));
                    }
                    event_log_capacity = parsed;
                }
                "--permission-timeout" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --permission-timeout".into())
                    })?;
                    let parsed = value.as_ref().parse::<u64>().map_err(|_| {
                        ParseCliError::Message(format!(
                            "invalid --permission-timeout '{}': expected a positive integer (seconds)",
                            value.as_ref()
                        ))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --permission-timeout '0': use a positive integer (seconds)".into(),
                        ));
                    }
                    permission_timeout_secs = parsed;
                }
                other if other.starts_with('-') => {
                    return Err(ParseCliError::Message(format!("unknown option '{other}'")));
                }
                other => {
                    return Err(ParseCliError::Message(format!(
                        "unexpected argument '{other}'"
                    )));
                }
            }
        }

        Ok(Self {
            host,
            port,
            event_log_capacity,
            permission_timeout_secs,
        })
    }
}

/// CLI parse failure for [`ServerConfig::from_args`].
#[derive(Debug, PartialEq, Eq)]
pub enum ParseCliError {
    Help,
    Message(String),
}

impl std::fmt::Display for ParseCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Help => write!(f, "help"),
            Self::Message(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ParseCliError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn bind_mode_parse_and_addrs() {
        assert_eq!(BindMode::parse("localhost"), Some(BindMode::Localhost));
        assert_eq!(BindMode::parse("127.0.0.1"), Some(BindMode::Localhost));
        assert_eq!(BindMode::parse("0.0.0.0"), Some(BindMode::All));
        assert_eq!(BindMode::parse("all"), Some(BindMode::All));
        assert_eq!(BindMode::parse("bogus"), None);

        assert_eq!(
            BindMode::Localhost.bind_addr(8080),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080)
        );
        assert_eq!(
            BindMode::All.bind_addr(8080),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8080)
        );
    }

    #[test]
    fn server_config_bind_addr() {
        let cfg = ServerConfig {
            host: "127.0.0.1".to_string(),
            port: 8080,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
        };
        assert_eq!(
            cfg.bind_addr(),
            Some(SocketAddr::from(([127, 0, 0, 1], 8080)))
        );

        let bad = ServerConfig {
            host: "example.com".to_string(),
            port: 8080,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
        };
        assert_eq!(bad.bind_addr(), None);
    }

    #[test]
    fn from_args_defaults() {
        let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("defaults");
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.event_log_capacity, 4096, "default event-log-capacity is 4096 (AC4)");
        assert_eq!(
            cfg.permission_timeout_secs, 60,
            "default permission-timeout is 60s (Story 1.7 / FR14)"
        );
    }

    #[test]
    fn from_args_host_and_port() {
        let cfg = ServerConfig::from_args(["--host", "0.0.0.0", "--port", "9090"]).expect("parse");
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 9090);
    }

    #[test]
    fn from_args_rejects_bogus_host() {
        assert!(matches!(
            ServerConfig::from_args(["--host", "example.com"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_help() {
        assert_eq!(
            ServerConfig::from_args(["--help"]),
            Err(ParseCliError::Help)
        );
    }

    #[test]
    fn from_args_rejects_port_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--port", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_accepts_event_log_capacity() {
        let cfg = ServerConfig::from_args(["--event-log-capacity", "1024"]).expect("parse");
        assert_eq!(cfg.event_log_capacity, 1024);
        // The other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
    }

    #[test]
    fn from_args_rejects_event_log_capacity_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_non_numeric_event_log_capacity() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity", "big"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_event_log_capacity_value() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_accepts_permission_timeout() {
        let cfg = ServerConfig::from_args(["--permission-timeout", "30"]).expect("parse");
        assert_eq!(cfg.permission_timeout_secs, 30);
        // Other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.event_log_capacity, 4096);
    }

    #[test]
    fn from_args_rejects_permission_timeout_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_non_numeric_permission_timeout() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout", "soon"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_permission_timeout_value() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_host_value() {
        assert!(matches!(
            ServerConfig::from_args(["--host"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_unknown_option() {
        assert!(matches!(
            ServerConfig::from_args(["--bogus"]),
            Err(ParseCliError::Message(_))
        ));
    }
}
