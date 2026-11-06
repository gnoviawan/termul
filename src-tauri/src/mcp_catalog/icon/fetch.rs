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

const NON_PUBLIC_V4: [(Ipv4Addr, u32); 14] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

const NON_PUBLIC_V6: [(Ipv6Addr, u32); 8] = [
    (Ipv6Addr::new(0, 0, 0, 0, 0xffff, 0, 0, 0), 96),
    (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48),
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32),
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
];

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let ip = u32::from(ip);
    NON_PUBLIC_V4
        .iter()
        .all(|(net, len)| (ip ^ u32::from(*net)) >> (32 - len) != 0)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = embedded_v4(ip) {
        return is_public_v4(v4);
    }
    let ip = u128::from(ip);
    NON_PUBLIC_V6
        .iter()
        .all(|(net, len)| (ip ^ u128::from(*net)) >> (128 - len) != 0)
}

/// The IPv4 address an IPv4-mapped, IPv4-compatible, NAT64 or 6to4 address
/// reaches.
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let v4 = |high: u16, low: u16| Some(Ipv4Addr::from((u32::from(high) << 16) | u32::from(low)));
    match ip.segments() {
        [0, 0, 0, 0, 0, 0xffff, high, low] | [0x64, 0xff9b, 0, 0, 0, 0, high, low] => v4(high, low),
        [0, 0, 0, 0, 0, 0, high, low] => v4(high, low),
        [0x2002, high, low, ..] => v4(high, low),
        _ => None,
    }
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

pub(crate) fn sniff(bytes: &[u8]) -> Option<IconType> {
    match bytes {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', ..] => Some(IconType::Png),
        [0xff, 0xd8, 0xff, ..] => Some(IconType::Jpeg),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some(IconType::Gif),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(IconType::Webp),
        _ => is_svg(bytes).then_some(IconType::Svg),
    }
}

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
