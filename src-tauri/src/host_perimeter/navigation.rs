//! Which navigation targets a tab webview may never load.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use tauri::Url;

/// Schemes Tauri serves app content and IPC on. On Windows and Android the
/// same content is served from `http(s)://<scheme>.localhost`.
const APP_SCHEMES: &[&str] = &["tauri", "ipc", "asset"];

const METADATA_HOSTNAMES: &[&str] = &["metadata.google.internal"];

/// AWS IPv6 instance metadata endpoint `fd00:ec2::254`.
const AWS_METADATA_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TabNavDenial {
    /// The app protocol, Tauri IPC or asset origins, or the dev server.
    AppOrigin,
    /// A loopback port termul listens on.
    OwnedPort(u16),
    /// `0.0.0.0` or `::`, which reach local listeners.
    UnspecifiedAddress,
    /// Link-local ranges and cloud metadata endpoints.
    LinkLocalOrMetadata,
}

impl TabNavDenial {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::AppOrigin => "app_origin",
            Self::OwnedPort(_) => "owned_port",
            Self::UnspecifiedAddress => "unspecified_address",
            Self::LinkLocalOrMetadata => "link_local_or_metadata",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostClass {
    App,
    Loopback,
    Unspecified,
    LinkLocalOrMetadata,
    Other,
}

/// `None` allows the navigation. Schemes other than http(s) and the app
/// schemes are left to other policy (`about:blank`, `data:` and the like).
pub(crate) fn tab_navigation_denial(
    url: &Url,
    is_owned_port: impl Fn(u16) -> bool,
    dev_url: Option<&Url>,
) -> Option<TabNavDenial> {
    let scheme = url.scheme();
    if APP_SCHEMES.contains(&scheme) {
        return Some(TabNavDenial::AppOrigin);
    }
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if dev_url.is_some_and(|dev| dev.origin() == url.origin()) {
        return Some(TabNavDenial::AppOrigin);
    }
    let port = url.port_or_known_default();
    match classify(url) {
        HostClass::App => Some(TabNavDenial::AppOrigin),
        HostClass::Unspecified => Some(TabNavDenial::UnspecifiedAddress),
        HostClass::LinkLocalOrMetadata => Some(TabNavDenial::LinkLocalOrMetadata),
        HostClass::Loopback => {
            let dev_port = dev_url
                .filter(|dev| classify(dev) == HostClass::Loopback)
                .and_then(Url::port_or_known_default);
            match port {
                Some(port) if dev_port == Some(port) => Some(TabNavDenial::AppOrigin),
                Some(port) if is_owned_port(port) => Some(TabNavDenial::OwnedPort(port)),
                _ => None,
            }
        }
        HostClass::Other => None,
    }
}

/// The URL parser already normalized numeric IPv4 spellings (`127.1`,
/// `2130706433`) to dotted form and bracketed IPv6.
fn classify(url: &Url) -> HostClass {
    let Some(host) = url.host_str() else {
        return HostClass::Other;
    };
    if let Some(v6) = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return v6
            .parse::<Ipv6Addr>()
            .map_or(HostClass::Other, |ip| classify_ip(IpAddr::V6(ip)));
    }
    match host.parse::<Ipv4Addr>() {
        Ok(ip) => classify_ip(IpAddr::V4(ip)),
        Err(_) => classify_domain(host),
    }
}

fn classify_domain(domain: &str) -> HostClass {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    if METADATA_HOSTNAMES.contains(&domain.as_str()) {
        return HostClass::LinkLocalOrMetadata;
    }
    if domain == "localhost" {
        return HostClass::Loopback;
    }
    match domain.strip_suffix(".localhost") {
        Some(label) if APP_SCHEMES.contains(&label) => HostClass::App,
        Some(_) => HostClass::Loopback,
        None => HostClass::Other,
    }
}

fn classify_ip(ip: IpAddr) -> HostClass {
    match ip {
        IpAddr::V4(ip) => classify_v4(ip),
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(mapped) => classify_v4(mapped),
            None if ip.is_unspecified() => HostClass::Unspecified,
            None if ip.is_loopback() => HostClass::Loopback,
            None if ip.is_unicast_link_local() || ip == AWS_METADATA_V6 => {
                HostClass::LinkLocalOrMetadata
            }
            None => HostClass::Other,
        },
    }
}

fn classify_v4(ip: Ipv4Addr) -> HostClass {
    if ip.is_unspecified() {
        HostClass::Unspecified
    } else if ip.is_loopback() {
        HostClass::Loopback
    } else if ip.is_link_local() {
        HostClass::LinkLocalOrMetadata
    } else {
        HostClass::Other
    }
}
