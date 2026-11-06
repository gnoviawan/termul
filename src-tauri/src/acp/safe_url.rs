use url::{Host, Url};

/// Stable error code of a refused link, the same on every transport.
pub const MCP_UNSAFE_URL: &str = "MCP_UNSAFE_URL";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opener {
    Host,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsafeUrl {
    ControlOrWhitespace,
    Unparseable,
    SchemeNotAllowed,
    HttpNotLoopback,
    LoopbackForRemote,
}

impl std::fmt::Display for UnsafeUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = match self {
            Self::ControlOrWhitespace => "it contains whitespace or control characters",
            Self::Unparseable => "it is not a valid URL",
            Self::SchemeNotAllowed => "only https links are allowed",
            Self::HttpNotLoopback => "http is allowed only for loopback addresses",
            Self::LoopbackForRemote => "a loopback link cannot open on a remote device",
        };
        write!(f, "refused an unsafe link: {reason}")
    }
}

impl std::error::Error for UnsafeUrl {}

pub fn check_safe_url(raw: &str, opener: Opener) -> Result<Url, UnsafeUrl> {
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(UnsafeUrl::ControlOrWhitespace);
    }
    let url = Url::parse(raw).map_err(|_| UnsafeUrl::Unparseable)?;
    match (url.scheme(), opener) {
        ("https", _) => Ok(url),
        ("http", _) if !is_loopback(&url) => Err(UnsafeUrl::HttpNotLoopback),
        ("http", Opener::Host) => Ok(url),
        ("http", Opener::Remote) => Err(UnsafeUrl::LoopbackForRemote),
        _ => Err(UnsafeUrl::SchemeNotAllowed),
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(domain)) => domain == "localhost",
        None => false,
    }
}

#[cfg(test)]
#[path = "safe_url_tests.rs"]
mod tests;
