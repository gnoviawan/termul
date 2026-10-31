//! The one path a logo takes from a publisher to the host. Every hop is
//! checked: `https`, a public address resolved by our own resolver (so the
//! connection goes to the address that was checked), at most
//! [`MAX_REDIRECTS`] redirects, a body cap, and a type sniffed from the bytes.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures_util::StreamExt;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

use super::{Icon, IconType};

pub(crate) const MAX_ICON_BYTES: usize = 512 * 1024;
pub(crate) const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPT: &str = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

/// Why a hop was refused before any byte was sent to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refused {
    NotHttps,
    NoHost,
    NonPublicAddress,
    NoAddresses,
    TooManyRedirects,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotHttps => "the icon URL is not https",
            Self::NoHost => "the icon URL has no host",
            Self::NonPublicAddress => "the icon host resolves to a non-public address",
            Self::NoAddresses => "the icon host has no addresses",
            Self::TooManyRedirects => "the icon redirected too many times",
        })
    }
}

impl std::error::Error for Refused {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FetchError {
    Refused(Refused),
    Timeout,
    Network(String),
    Status(u16),
    TooLarge,
    NotAnImage,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refused) => refused.fmt(f),
            Self::Timeout => f.write_str("the icon request timed out"),
            Self::Network(error) => write!(f, "the icon request failed: {error}"),
            Self::Status(status) => write!(f, "the icon host returned HTTP {status}"),
            Self::TooLarge => write!(f, "the icon is larger than {MAX_ICON_BYTES} bytes"),
            Self::NotAnImage => f.write_str("the icon is not a PNG, JPEG, WebP, GIF or SVG"),
        }
    }
}

impl From<reqwest::Error> for FetchError {
    fn from(error: reqwest::Error) -> Self {
        let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
        while let Some(current) = source {
            if let Some(refused) = current.downcast_ref::<Refused>() {
                return Self::Refused(*refused);
            }
            source = current.source();
        }
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Network(error.without_url().to_string())
        }
    }
}

/// Which hops may be fetched. Production allows only `https` to public
/// addresses; tests swap in a loopback `http` policy to reach a local server.
#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub scheme: &'static str,
    pub allows: fn(IpAddr) -> bool,
}

impl Policy {
    pub(crate) const PUBLIC_HTTPS: Self = Self {
        scheme: "https",
        allows: is_public,
    };

    /// The resolver never sees an IP-literal host, so those are checked here.
    pub(crate) fn check(self, url: &Url) -> Result<(), Refused> {
        if url.scheme() != self.scheme {
            return Err(Refused::NotHttps);
        }
        let ip = match url.host() {
            None => return Err(Refused::NoHost),
            Some(Host::Domain(_)) => return Ok(()),
            Some(Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(Host::Ipv6(ip)) => IpAddr::V6(ip),
        };
        if (self.allows)(ip) {
            Ok(())
        } else {
            Err(Refused::NonPublicAddress)
        }
    }
}

pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        // 100.64.0.0/10 carrier-grade NAT.
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24 IETF protocol assignments.
        || (a == 192 && b == 0 && c == 0)
        // 198.18.0.0/15 benchmarking.
        || (a == 198 && (18..20).contains(&b))
        // 240.0.0.0/4 reserved.
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let segments = ip.segments();
    let embedded_v4 = |high: u16, low: u16| {
        let [a, b] = high.to_be_bytes();
        let [c, d] = low.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    match segments {
        // 64:ff9b::/96 NAT64 and ::/96 IPv4-compatible carry an IPv4 address.
        [0x64, 0xff9b, 0, 0, 0, 0, high, low] | [0, 0, 0, 0, 0, 0, high, low]
            if !ip.is_loopback() && !ip.is_unspecified() =>
        {
            return is_public_v4(embedded_v4(high, low));
        }
        // 2002::/16 6to4 carries one in its next 32 bits.
        [0x2002, high, low, ..] => return is_public_v4(embedded_v4(high, low)),
        _ => {}
    }
    let first = segments[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7 unique local.
        || (first & 0xfe00) == 0xfc00
        // fe80::/10 link local, fec0::/10 deprecated site local.
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        // 2001:db8::/32 documentation, 2001::/32 Teredo.
        || (first == 0x2001 && (segments[1] == 0x0db8 || segments[1] == 0)))
}

pub(crate) type Lookup =
    Arc<dyn Fn(String) -> BoxFuture<'static, std::io::Result<Vec<IpAddr>>> + Send + Sync>;

pub(crate) fn system_lookup() -> Lookup {
    Arc::new(|host| {
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .map(|address| address.ip())
                .collect())
        })
    })
}

/// Hands reqwest only addresses the policy allows, so the socket connects to
/// exactly what was checked and a second DNS answer can't swap it.
struct GuardedResolver {
    policy: Policy,
    lookup: Lookup,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = (self.lookup)(name.as_str().to_string());
        let allows = self.policy.allows;
        Box::pin(async move {
            let ips = lookup.await?;
            if ips.is_empty() {
                return Err(Refused::NoAddresses.into());
            }
            if !ips.iter().all(|ip| allows(*ip)) {
                return Err(Refused::NonPublicAddress.into());
            }
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

pub(crate) struct IconClient {
    client: reqwest::Client,
    policy: Policy,
}

impl IconClient {
    pub(crate) fn new(policy: Policy, lookup: Lookup) -> reqwest::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            .dns_resolver(Arc::new(GuardedResolver { policy, lookup }))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() > MAX_REDIRECTS {
                    return attempt.error(Refused::TooManyRedirects);
                }
                match policy.check(attempt.url()) {
                    Ok(()) => attempt.follow(),
                    Err(refused) => attempt.error(refused),
                }
            }))
            .build()?;
        Ok(Self { client, policy })
    }

    pub(crate) async fn fetch(&self, url: &Url) -> Result<Icon, FetchError> {
        self.policy.check(url).map_err(FetchError::Refused)?;
        let response = self
            .client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, ACCEPT)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(FetchError::Status(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ICON_BYTES as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if body.len() + chunk.len() > MAX_ICON_BYTES {
                return Err(FetchError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let content_type = sniff(&body).ok_or(FetchError::NotAnImage)?;
        Ok(Icon {
            content_type,
            bytes: body.into(),
        })
    }
}

/// The type the bytes are, whatever the response header claimed.
pub(crate) fn sniff(bytes: &[u8]) -> Option<IconType> {
    match bytes {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', ..] => Some(IconType::Png),
        [0xff, 0xd8, 0xff, ..] => Some(IconType::Jpeg),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some(IconType::Gif),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(IconType::Webp),
        _ => is_svg(bytes).then_some(IconType::Svg),
    }
}

/// UTF-8 whose first element, after any XML declaration, comments and
/// doctype, is `<svg`.
fn is_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut rest = text.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start();
        let skip_to = if rest.starts_with("<?") {
            "?>"
        } else if rest.starts_with("<!--") {
            "-->"
        } else if rest
            .get(..9)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<!doctype"))
        {
            ">"
        } else {
            break;
        };
        match rest.find(skip_to) {
            Some(end) => rest = &rest[end + skip_to.len()..],
            None => return false,
        }
    }
    rest.strip_prefix("<svg")
        .and_then(|after| after.chars().next())
        .is_some_and(|next| next.is_ascii_whitespace() || next == '>' || next == '/')
}
