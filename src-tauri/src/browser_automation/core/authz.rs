//! Origin authorization: the origin class of every navigation target and
//! the per-hop verdict, plus the per-session grants and the policy
//! snapshot the synchronous engine navigation hook decides from.
//!
//! Classes are computed on the engine-canonical host (the WHATWG URL
//! parser normalizes decimal, octal and hex IPv4 forms), checked in this
//! order: denied (never promptable), loopback (auto-granted except on
//! ports termul itself listens on), allow-listed (auto-granted), private
//! network (prompt), everything else (prompt once per session).
//!
//! While the app's "ask before opening new sites" switch is off (the
//! default) a promptable origin is allowed without a prompt, but it is not
//! granted: its class stays promptable, so the sensitive-action gates still
//! treat it as unvouched. `file://` URLs never get an origin class: a hop
//! to one is allowed only by an exact grant of its real-path URL, made by
//! the consent gate after the host checked the file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::net::{Ipv4Addr, Ipv6Addr};

use parking_lot::Mutex;
use tauri::Url;

use super::ports::{ActionClass, CanonicalOrigin};
use crate::acp::browser_policy::{OriginPattern, ReservedKind};

/// Hostnames the Tauri runtime serves the app and its protocols on.
const APP_HOSTS: [&str; 3] = ["tauri.localhost", "ipc.localhost", "asset.localhost"];

const METADATA_HOSTS: [&str; 1] = ["metadata.google.internal"];
const METADATA_V4: Ipv4Addr = Ipv4Addr::new(169, 254, 169, 254);
const METADATA_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254);


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    Scheme,
    TermulOwned,
    AppOrigin,
    UnspecifiedAddress,
    MetadataAddress,
    LinkLocal,
    /// A `file://` URL the session holds no grant for.
    FileNotGranted,
}

impl DenyReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DenyReason::Scheme => "scheme_not_allowed",
            DenyReason::TermulOwned => "troupe_owned_origin",
            DenyReason::AppOrigin => "app_origin",
            DenyReason::UnspecifiedAddress => "unspecified_address",
            DenyReason::MetadataAddress => "metadata_address",
            DenyReason::LinkLocal => "link_local_address",
            DenyReason::FileNotGranted => "file_not_granted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    Unlisted,
    LocalNetwork,
}

impl PromptKind {
    pub fn action(self) -> ActionClass {
        match self {
            PromptKind::Unlisted => ActionClass::Navigate,
            PromptKind::LocalNetwork => ActionClass::LocalNetwork,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginClass {
    Loopback,
    AllowListed,
    Prompt(PromptKind),
    Denied(DenyReason),
}

enum HostKind {
    Loopback,
    LocalNetwork,
    Public,
    Denied(DenyReason),
}

fn classify_v4(ip: Ipv4Addr) -> HostKind {
    let [a, b, ..] = ip.octets();
    if ip.is_unspecified() {
        HostKind::Denied(DenyReason::UnspecifiedAddress)
    } else if ip == METADATA_V4 {
        HostKind::Denied(DenyReason::MetadataAddress)
    } else if ip.is_link_local() {
        HostKind::Denied(DenyReason::LinkLocal)
    } else if ip.is_loopback() {
        HostKind::Loopback
    } else if ip.is_private() || (a == 100 && (64..128).contains(&b)) {
        HostKind::LocalNetwork
    } else {
        HostKind::Public
    }
}

fn classify_v6(ip: Ipv6Addr) -> HostKind {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return classify_v4(v4);
    }
    let first = ip.segments()[0];
    if ip.is_unspecified() {
        HostKind::Denied(DenyReason::UnspecifiedAddress)
    } else if ip == METADATA_V6 {
        HostKind::Denied(DenyReason::MetadataAddress)
    } else if first & 0xffc0 == 0xfe80 {
        HostKind::Denied(DenyReason::LinkLocal)
    } else if ip.is_loopback() {
        HostKind::Loopback
    } else if first & 0xfe00 == 0xfc00 {
        HostKind::LocalNetwork
    } else {
        HostKind::Public
    }
}

fn classify_domain(domain: &str) -> HostKind {
    let domain = domain.strip_suffix('.').unwrap_or(domain);
    if APP_HOSTS.contains(&domain) {
        HostKind::Denied(DenyReason::AppOrigin)
    } else if METADATA_HOSTS.contains(&domain) {
        HostKind::Denied(DenyReason::MetadataAddress)
    } else if domain == "localhost" || domain.ends_with(".localhost") {
        HostKind::Loopback
    } else {
        HostKind::Public
    }
}

fn reserved_reason(kind: ReservedKind) -> DenyReason {
    match kind {
        ReservedKind::Unspecified => DenyReason::UnspecifiedAddress,
        ReservedKind::Metadata => DenyReason::MetadataAddress,
        ReservedKind::AppOrigin => DenyReason::AppOrigin,
        ReservedKind::TermulPort => DenyReason::TermulOwned,
    }
}

/// The origin class of `url`. `owned_port` says whether a loopback port
/// is one termul listens on.
pub fn classify(
    url: &Url,
    owned_port: impl Fn(u16) -> bool,
    allow_list: &[OriginPattern],
) -> OriginClass {
    if !matches!(url.scheme(), "http" | "https") {
        return OriginClass::Denied(DenyReason::Scheme);
    }
    let Some(host) = url.host_str() else {
        return OriginClass::Denied(DenyReason::Scheme);
    };
    // The parser already serialized IP hosts canonically: dotted quad, or
    // bracketed compressed IPv6.
    let kind = if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        match v6.parse::<Ipv6Addr>() {
            Ok(ip) => classify_v6(ip),
            Err(_) => return OriginClass::Denied(DenyReason::Scheme),
        }
    } else if let Ok(ip) = host.parse::<Ipv4Addr>() {
        classify_v4(ip)
    } else {
        classify_domain(host)
    };
    let origin = CanonicalOrigin::parse(url.as_str()).ok();
    // Every origin the policy refuses to allow-list is also unreachable.
    if let Some(reserved) = origin.as_ref().and_then(|o| o.reserved_kind(&[])) {
        if !matches!(kind, HostKind::Denied(_)) {
            return OriginClass::Denied(reserved_reason(reserved));
        }
    }
    let listed = || {
        origin
            .as_ref()
            .is_some_and(|origin| allow_list.iter().any(|p| p.matches(origin)))
    };
    match kind {
        HostKind::Denied(reason) => OriginClass::Denied(reason),
        HostKind::Loopback => match url.port_or_known_default() {
            Some(port) if owned_port(port) => OriginClass::Denied(DenyReason::TermulOwned),
            _ => OriginClass::Loopback,
        },
        _ if listed() => OriginClass::AllowListed,
        HostKind::LocalNetwork => OriginClass::Prompt(PromptKind::LocalNetwork),
        HostKind::Public => OriginClass::Prompt(PromptKind::Unlisted),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopVerdict {
    Allow,
    Deny(DenyReason),
    /// Promptable, but not granted for this session yet.
    Ungranted(PromptKind, CanonicalOrigin),
}

/// Fold a class and the session's grants into a verdict for one hop.
/// `ask_sites` is the app's "ask before opening new sites" switch: off,
/// a promptable origin is allowed without being granted.
pub fn hop_verdict(
    url: &Url,
    class: OriginClass,
    ask_sites: bool,
    granted: impl Fn(&CanonicalOrigin) -> bool,
) -> HopVerdict {
    match class {
        OriginClass::Loopback | OriginClass::AllowListed => HopVerdict::Allow,
        OriginClass::Denied(reason) => HopVerdict::Deny(reason),
        OriginClass::Prompt(kind) => match CanonicalOrigin::parse(url.as_str()) {
            Ok(origin) if granted(&origin) => HopVerdict::Allow,
            Ok(_) if !ask_sites => HopVerdict::Allow,
            Ok(origin) => HopVerdict::Ungranted(kind, origin),
            Err(_) => HopVerdict::Deny(DenyReason::Scheme),
        },
    }
}

/// The key a `file://` URL is granted under: its decoded local path, so
/// every spelling of one file (engine, page link, `Url::from_file_path`)
/// meets one grant. On Windows, where drive letters ignore case, the drive
/// letter is lowercased. Query and fragment are not part of it. `None` for
/// any other scheme, for a file URL with a host (a UNC share), and for one
/// that names no local path or a path that is not UTF-8: none is ever
/// granted.
pub fn file_key(url: &Url) -> Option<String> {
    if url.scheme() != "file" || url.host_str().is_some_and(|h| !h.is_empty()) {
        return None;
    }
    let path = url.to_file_path().ok()?;
    let mut key = path.to_str()?.to_string();
    // Windows paths (backslash-separated) start with a case-blind drive.
    let windows = std::path::MAIN_SEPARATOR == '\\';
    if windows && key.as_bytes().get(1) == Some(&b':') {
        key[..1].make_ascii_lowercase();
    }
    Some(key)
}

/// An "allow once" file grant: the tabs showing the file, and whether the
/// approved load has yet to land in one.
#[derive(Default)]
struct OnceFile {
    tabs: HashSet<String>,
    loading: bool,
}

/// The policy a session's synchronous hop checks decide from, as of its
/// last authorized call, and the grants it holds.
struct SessionAuthz {
    granted: HashSet<CanonicalOrigin>,
    /// Exact real-path `file://` URLs (see [`file_key`]) the agent opened,
    /// each with the directory WebKit may let its page read.
    granted_files: HashMap<String, PathBuf>,
    /// Files outside the project allowed "once": each lasts while a tab
    /// stays on it, and goes when the last such tab leaves it or a later
    /// prompt for it is denied.
    once_files: HashMap<String, OnceFile>,
    allow_list: Vec<OriginPattern>,
    /// The app's "ask before opening new sites" switch. Asks until the
    /// session's first authorized call read it.
    ask_sites: bool,
    /// The policy generation the snapshot was read at.
    generation: u64,
}

impl SessionAuthz {
    fn replace_policy(&mut self, generation: u64, allow_list: Vec<OriginPattern>, ask_sites: bool) {
        if generation < self.generation {
            return;
        }
        self.generation = generation;
        self.allow_list = allow_list;
        self.ask_sites = ask_sites;
    }
}

impl Default for SessionAuthz {
    fn default() -> Self {
        Self {
            granted: HashSet::new(),
            granted_files: HashMap::new(),
            once_files: HashMap::new(),
            allow_list: Vec::new(),
            ask_sites: true,
            generation: 0,
        }
    }
}

/// Per-session origin grants, keyed `(session, origin)`. They end at
/// session end and at Stop.
#[derive(Default)]
pub struct SessionGrants {
    sessions: Mutex<HashMap<String, SessionAuthz>>,
}

impl SessionGrants {
    pub fn grant(&self, session_id: &str, origin: CanonicalOrigin) {
        self.sessions
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .granted
            .insert(origin);
    }

    /// Grant the exact file `url`, whose page may read `read_access`.
    pub fn grant_file(&self, session_id: &str, url: &Url, read_access: &Path) {
        let Some(key) = file_key(url) else {
            return;
        };
        self.sessions
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .granted_files
            .insert(key, read_access.to_path_buf());
    }

    /// Grant the file `url` only while the session still holds `source`, in
    /// one step under the session lock: a revoke cannot land between the
    /// check and the grant. Returns whether it granted.
    pub fn grant_file_if_held(&self, session_id: &str, source: &Url, url: &Url, read_access: &Path) -> bool {
        let (Some(source), Some(key)) = (file_key(source), file_key(url)) else {
            return false;
        };
        let mut sessions = self.sessions.lock();
        let Some(session) = sessions.get_mut(session_id) else {
            return false;
        };
        if !session.granted_files.contains_key(&source) {
            return false;
        }
        session.granted_files.insert(key, read_access.to_path_buf());
        true
    }

    /// Grant the outside file `url` once: it stays granted while a tab that
    /// loaded it after this grant stays on it.
    pub fn grant_file_once(&self, session_id: &str, url: &Url, read_access: &Path) {
        let Some(key) = file_key(url) else {
            return;
        };
        let mut sessions = self.sessions.lock();
        let session = sessions.entry(session_id.to_string()).or_default();
        session.granted_files.insert(key.clone(), read_access.to_path_buf());
        session.once_files.entry(key).or_default().loading = true;
    }

    /// Drop the grant of the file `url` (a later prompt for it was denied).
    pub fn revoke_file(&self, session_id: &str, url: &Url) {
        let Some(key) = file_key(url) else {
            return;
        };
        if let Some(session) = self.sessions.lock().get_mut(session_id) {
            session.granted_files.remove(&key);
            session.once_files.remove(&key);
        }
    }

    /// Tab `tab` of the session committed `url` (or closed, with `None`):
    /// an "allow once" file the tab showed and no tab shows any longer
    /// loses its grant. Returns how many grants ended.
    pub fn tab_moved(&self, session_id: &str, tab: &str, url: Option<&Url>) -> usize {
        let landed = url.and_then(file_key);
        let mut sessions = self.sessions.lock();
        let Some(session) = sessions.get_mut(session_id) else {
            return 0;
        };
        let mut ended = Vec::new();
        for (key, once) in &mut session.once_files {
            if landed.as_deref() == Some(key.as_str()) {
                if once.loading {
                    once.loading = false;
                    once.tabs.insert(tab.to_string());
                }
            } else if once.tabs.remove(tab) && once.tabs.is_empty() && !once.loading {
                ended.push(key.clone());
            }
        }
        for key in &ended {
            session.once_files.remove(key);
            session.granted_files.remove(key);
        }
        ended.len()
    }

    /// The directory the granted file `url`'s page may read; `None` when
    /// the session holds no grant for it.
    pub fn file_read_access(&self, session_id: &str, url: &Url) -> Option<PathBuf> {
        let key = file_key(url)?;
        self.sessions
            .lock()
            .get(session_id)?
            .granted_files
            .get(&key)
            .cloned()
    }

    pub fn revoke_session(&self, session_id: &str) {
        if let Some(session) = self.sessions.lock().get_mut(session_id) {
            session.granted.clear();
            session.granted_files.clear();
            session.once_files.clear();
        }
    }

    pub fn forget_session(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }

    /// The sessions holding a snapshot.
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }

    /// Replace the snapshot of a session that has one; a session that
    /// ended in the meantime stays gone.
    pub fn refresh_policy(&self, session_id: &str, generation: u64, allow_list: Vec<OriginPattern>, ask_sites: bool) {
        if let Some(session) = self.sessions.lock().get_mut(session_id) {
            session.replace_policy(generation, allow_list, ask_sites);
        }
    }

    /// Snapshot the policy the synchronous hop checks decide from, read at
    /// policy `generation`. A snapshot of an older generation than the one
    /// held is dropped.
    pub fn set_policy(&self, session_id: &str, generation: u64, allow_list: Vec<OriginPattern>, ask_sites: bool) {
        let mut sessions = self.sessions.lock();
        let session = sessions.entry(session_id.to_string()).or_default();
        session.replace_policy(generation, allow_list, ask_sites);
    }

    /// The origin class of `url` against the session's allow-list snapshot.
    pub fn class_of(&self, session_id: &str, url: &Url) -> OriginClass {
        let sessions = self.sessions.lock();
        let allow_list = sessions
            .get(session_id)
            .map_or(&[][..], |s| s.allow_list.as_slice());
        classify(url, crate::host_perimeter::is_owned_port, allow_list)
    }

    /// The verdict for one navigation hop of a session-owned tab, from the
    /// grants and policy snapshot alone (no I/O: the engine hook that
    /// calls this cannot wait). `about:blank` is the engine's own empty
    /// document and carries no request.
    pub fn check_hop(&self, session_id: &str, url: &Url) -> HopVerdict {
        if url.as_str() == "about:blank" {
            return HopVerdict::Allow;
        }
        let sessions = self.sessions.lock();
        let session = sessions.get(session_id);
        if url.scheme() == "file" {
            let granted = file_key(url)
                .is_some_and(|key| session.is_some_and(|s| s.granted_files.contains_key(&key)));
            return if granted {
                HopVerdict::Allow
            } else {
                HopVerdict::Deny(DenyReason::FileNotGranted)
            };
        }
        let allow_list = session.map_or(&[][..], |s| s.allow_list.as_slice());
        let ask_sites = session.is_none_or(|s| s.ask_sites);
        let class = classify(url, crate::host_perimeter::is_owned_port, allow_list);
        hop_verdict(url, class, ask_sites, |origin| {
            session.is_some_and(|s| s.granted.contains(origin))
        })
    }

    /// Whether `url` passes only because the session opens new sites
    /// without asking: allowed, yet neither granted nor vouched for.
    pub fn opened_unasked(&self, session_id: &str, url: &Url) -> bool {
        let sessions = self.sessions.lock();
        let Some(session) = sessions.get(session_id) else {
            return false;
        };
        if session.ask_sites {
            return false;
        }
        let class = classify(url, crate::host_perimeter::is_owned_port, &session.allow_list);
        matches!(class, OriginClass::Prompt(_))
            && CanonicalOrigin::parse(url.as_str()).is_ok_and(|origin| !session.granted.contains(&origin))
    }
}

#[cfg(test)]
#[path = "authz_tests.rs"]
mod tests;
