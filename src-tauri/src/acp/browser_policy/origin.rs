//! Canonical origins and allow-list patterns for the browser policy.
//!
//! An origin is `scheme://host[:port]` for http(s) only, with the host
//! lowercased and punycoded and the default port elided. A pattern is one
//! exact origin or a `*.` subdomain suffix. Termul's own listeners, the app
//! webview origins and metadata or unspecified addresses can never be
//! allow-listed, because the policy only ever widens what an agent may reach.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use serde::{Serialize, Serializer};

/// Loopback ports termul itself listens on, read at the moment of a check
/// because the shared-live host starts and stops at runtime.
pub type OwnedPorts = Arc<dyn Fn() -> Vec<u16> + Send + Sync>;

/// Why an origin or pattern was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginError {
    Empty,
    Malformed,
    UnsupportedScheme,
    Userinfo,
    /// A `*` anywhere but a leading `*.` host label.
    Wildcard,
    /// A `*.` suffix on an IP address or a bare top-level label.
    WildcardTooBroad,
    Reserved(ReservedKind),
}

impl OriginError {
    /// Stable machine reason carried in the `invalid_params` reply.
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Empty | Self::Malformed | Self::UnsupportedScheme | Self::Userinfo => {
                "invalid_origin"
            }
            Self::Wildcard | Self::WildcardTooBroad => "invalid_wildcard",
            Self::Reserved(_) => "reserved_origin",
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::Empty => "origin is empty",
            Self::Malformed => "origin is not a valid http(s) origin",
            Self::UnsupportedScheme => "only http and https origins are supported",
            Self::Userinfo => "origin must not contain credentials",
            Self::Wildcard => "a wildcard is only allowed as a leading `*.` host label",
            Self::WildcardTooBroad => {
                "a wildcard needs a registrable domain, not an IP or a bare label"
            }
            Self::Reserved(kind) => kind.message(),
        }
    }
}

/// The class of host termul never lets a policy widen access to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservedKind {
    /// `0.0.0.0` and `::`.
    Unspecified,
    /// Link-local ranges and cloud metadata endpoints.
    Metadata,
    /// `tauri.localhost`, `ipc.localhost`, `asset.localhost`.
    AppOrigin,
    /// A loopback host on a port termul listens on.
    TermulPort,
}

impl ReservedKind {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unspecified => "the unspecified address cannot be allow-listed",
            Self::Metadata => "link-local and metadata addresses cannot be allow-listed",
            Self::AppOrigin => "termul's own app origins cannot be allow-listed",
            Self::TermulPort => "ports termul listens on cannot be allow-listed",
        }
    }
}

/// Canonical origin `scheme://host[:port]`: http(s) only, lowercase,
/// punycode host, default port elided.
#[derive(Debug, Clone)]
pub struct CanonicalOrigin {
    repr: String,
    https: bool,
    host_start: usize,
    port: Option<u16>,
}

impl PartialEq for CanonicalOrigin {
    fn eq(&self, other: &Self) -> bool {
        self.repr == other.repr
    }
}

impl Eq for CanonicalOrigin {}

impl std::hash::Hash for CanonicalOrigin {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.repr.hash(state);
    }
}

impl Serialize for CanonicalOrigin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.repr)
    }
}

impl CanonicalOrigin {
    /// Parse a URL or a bare origin, keeping only its origin.
    pub fn parse(input: &str) -> Result<Self, OriginError> {
        let input = input.trim();
        if input.is_empty() {
            return Err(OriginError::Empty);
        }
        // The URL parser drops tabs and newlines silently, which would let
        // two spellings of one origin through.
        if input.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(OriginError::Malformed);
        }
        let url = input
            .parse::<tauri::Url>()
            .map_err(|_| OriginError::Malformed)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(OriginError::UnsupportedScheme);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(OriginError::Userinfo);
        }
        let host = url.host_str().ok_or(OriginError::Malformed)?;
        if host.contains('*') {
            return Err(OriginError::Wildcard);
        }
        let repr = match url.port() {
            Some(port) => format!("{}://{host}:{port}", url.scheme()),
            None => format!("{}://{host}", url.scheme()),
        };
        Ok(Self {
            repr,
            https: url.scheme() == "https",
            host_start: url.scheme().len() + "://".len(),
            port: url.port(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.repr
    }

    fn host(&self) -> &str {
        let end = match self.port {
            Some(_) => self.repr.rfind(':').unwrap_or(self.repr.len()),
            None => self.repr.len(),
        };
        &self.repr[self.host_start..end]
    }

    fn effective_port(&self) -> u16 {
        self.port.unwrap_or(if self.https { 443 } else { 80 })
    }

    /// The reserved class of this origin, if any. `owned_ports` are the
    /// loopback ports termul listens on right now.
    pub fn reserved_kind(&self, owned_ports: &[u16]) -> Option<ReservedKind> {
        let bare = self.host().trim_end_matches('.');
        if let Some(ip) = parse_ip(bare) {
            return reserved_ip(ip, self.effective_port(), owned_ports);
        }
        let lower = bare.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "tauri.localhost" | "ipc.localhost" | "asset.localhost"
        ) {
            return Some(ReservedKind::AppOrigin);
        }
        if matches!(
            lower.as_str(),
            "metadata.google.internal" | "metadata.goog" | "instance-data"
        ) {
            return Some(ReservedKind::Metadata);
        }
        let loopback = lower == "localhost" || lower.ends_with(".localhost");
        (loopback && owned_ports.contains(&self.effective_port()))
            .then_some(ReservedKind::TermulPort)
    }
}

fn parse_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

fn reserved_ip(ip: IpAddr, port: u16, owned_ports: &[u16]) -> Option<ReservedKind> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) if v4.is_unspecified() => Some(ReservedKind::Unspecified),
        IpAddr::V6(v6) if v6.is_unspecified() => Some(ReservedKind::Unspecified),
        IpAddr::V4(v4) if is_metadata_v4(v4) => Some(ReservedKind::Metadata),
        IpAddr::V6(v6) if is_metadata_v6(v6) => Some(ReservedKind::Metadata),
        ip if ip.is_loopback() && owned_ports.contains(&port) => Some(ReservedKind::TermulPort),
        _ => None,
    }
}

fn is_metadata_v4(ip: Ipv4Addr) -> bool {
    ip.is_link_local() || matches!(ip.octets(), [100, 100, 100, 200] | [168, 63, 129, 16])
}

fn is_metadata_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80 || ip == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)
}

/// An allow-list entry: one exact origin, or every subdomain of a host
/// (`https://*.example.com`, which does not match `example.com` itself).
/// Never a bare `*`, a scheme wildcard or a port wildcard.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum OriginPattern {
    Exact(CanonicalOrigin),
    Subdomains {
        /// Canonical origin of the parent host, e.g. `https://example.com`.
        parent: CanonicalOrigin,
    },
}

impl OriginPattern {
    /// Parse and canonicalize. Edits go through [`Self::parse_allowed`],
    /// which adds the reserved-origin rule.
    pub fn parse(input: &str) -> Result<Self, OriginError> {
        let input = input.trim();
        match input.split_once("://*.") {
            Some((scheme, rest)) => {
                if rest.contains('*') {
                    return Err(OriginError::Wildcard);
                }
                let parent = CanonicalOrigin::parse(&format!("{scheme}://{rest}"))?;
                let host = parent.host().trim_end_matches('.');
                if parse_ip(host).is_some() || !host.contains('.') {
                    return Err(OriginError::WildcardTooBroad);
                }
                Ok(Self::Subdomains { parent })
            }
            None if input.contains('*') => Err(OriginError::Wildcard),
            None => CanonicalOrigin::parse(input).map(Self::Exact),
        }
    }

    /// [`Self::parse`] plus the reserved-origin rule.
    pub fn parse_allowed(input: &str, owned_ports: &[u16]) -> Result<Self, OriginError> {
        let pattern = Self::parse(input)?;
        let anchor = match &pattern {
            Self::Exact(origin) => origin,
            Self::Subdomains { parent } => parent,
        };
        if let Some(kind) = anchor.reserved_kind(owned_ports) {
            return Err(OriginError::Reserved(kind));
        }
        if let Self::Subdomains { parent } = &pattern {
            // A suffix on a reserved parent would still cover its children.
            let host = parent.host().trim_end_matches('.').to_ascii_lowercase();
            if host == "localhost" || host.ends_with(".localhost") {
                return Err(OriginError::Reserved(ReservedKind::AppOrigin));
            }
        }
        Ok(pattern)
    }

    pub fn matches(&self, origin: &CanonicalOrigin) -> bool {
        match self {
            Self::Exact(exact) => exact == origin,
            Self::Subdomains { parent } => {
                let (scheme, host_port) = parent.as_str().split_once("://").unwrap_or_default();
                origin
                    .as_str()
                    .strip_prefix(scheme)
                    .and_then(|rest| rest.strip_prefix("://"))
                    .and_then(|rest| rest.strip_suffix(host_port))
                    .is_some_and(|sub| sub.len() > 1 && sub.ends_with('.'))
            }
        }
    }

    /// The canonical text form clients show and send back.
    pub fn to_canonical_string(&self) -> String {
        match self {
            Self::Exact(origin) => origin.as_str().to_string(),
            Self::Subdomains { parent } => parent.as_str().replacen("://", "://*.", 1),
        }
    }
}

#[cfg(test)]
#[path = "origin_tests.rs"]
mod tests;
