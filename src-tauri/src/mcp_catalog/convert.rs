//! The AD-4 conversion contract: a registry `server.json` becomes install
//! options, each with exactly one host-computed outcome. The executable always
//! comes from a fixed runner template, never from registry text.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::LazyLock;

use regex::Regex;
use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

use crate::acp::safe_url::{check_safe_url, Opener};

// ---------------------------------------------------------------------------
// Registry input. Lenient: unknown fields are ignored and `null` reads as the
// default, so an entry on an older schema still parses (AD-2).
// ---------------------------------------------------------------------------

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RegistryServer {
    pub name: String,
    pub title: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub description: String,
    pub version: String,
    pub repository: Option<RegistryRepository>,
    #[serde(deserialize_with = "null_as_default")]
    pub remotes: Vec<RegistryRemote>,
    #[serde(deserialize_with = "null_as_default")]
    pub packages: Vec<RegistryPackage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RegistryRepository {
    pub url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RegistryRemote {
    #[serde(rename = "type")]
    pub transport: String,
    pub url: String,
    #[serde(deserialize_with = "null_as_default")]
    pub headers: Vec<RegistryInput>,
    #[serde(deserialize_with = "null_as_default")]
    pub variables: BTreeMap<String, RegistryInput>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RegistryPackage {
    pub registry_type: String,
    pub identifier: String,
    pub version: Option<String>,
    pub registry_base_url: Option<String>,
    pub runtime_hint: Option<String>,
    pub transport: Option<RegistryPackageTransport>,
    #[serde(deserialize_with = "null_as_default")]
    pub runtime_arguments: Vec<IgnoredAny>,
    #[serde(deserialize_with = "null_as_default")]
    pub package_arguments: Vec<RegistryInput>,
    #[serde(deserialize_with = "null_as_default")]
    pub environment_variables: Vec<RegistryInput>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RegistryPackageTransport {
    #[serde(rename = "type")]
    pub kind: String,
}

/// An argument, header, env var or template variable. Only what conversion
/// needs: the name and whether it, or any variable inside it, is secret.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RegistryInput {
    #[serde(deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(deserialize_with = "null_as_default")]
    pub is_secret: bool,
    #[serde(deserialize_with = "null_as_default")]
    pub variables: BTreeMap<String, RegistryInput>,
}

impl RegistryInput {
    fn is_secret_anywhere(&self) -> bool {
        self.is_secret || self.variables.values().any(Self::is_secret_anywhere)
    }
}

// ---------------------------------------------------------------------------
// Conversion output
// ---------------------------------------------------------------------------

/// The four fixed runner templates. Each needs its executable on the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Runner {
    Npx,
    Uvx,
    Docker,
    Dotnet,
}

impl Runner {
    fn for_registry_type(registry_type: &str) -> Option<Self> {
        match registry_type {
            "npm" => Some(Self::Npx),
            "pypi" => Some(Self::Uvx),
            "oci" => Some(Self::Docker),
            "nuget" => Some(Self::Dotnet),
            _ => None,
        }
    }

    /// The executable the template runs.
    #[must_use]
    pub fn command(self) -> &'static str {
        match self {
            Self::Npx => "npx",
            Self::Uvx => "uvx",
            Self::Docker => "docker",
            Self::Dotnet => "dotnet",
        }
    }

    /// The one registry a package row may name for this runner. OCI names its
    /// registry in the image reference instead.
    fn default_registry(self) -> Option<&'static str> {
        match self {
            Self::Npx => Some("https://registry.npmjs.org"),
            Self::Uvx => Some("https://pypi.org"),
            Self::Dotnet => Some("https://api.nuget.org/v3/index.json"),
            Self::Docker => None,
        }
    }

    /// The registry `runtimeHint` that names this runner.
    fn runtime_hint(self) -> &'static str {
        match self {
            Self::Npx => "npx",
            Self::Uvx => "uvx",
            Self::Docker => "docker",
            Self::Dotnet => "dnx",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTransport {
    Http,
    Sse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Remote {
        transport: RemoteTransport,
        url: String,
    },
    /// `argv[0]` is `runner.command()`. Registry `packageArguments` are not
    /// here: the install plan appends them once the user has filled them in.
    Stdio { runner: Runner, argv: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OptionKind {
    Remote,
    Package,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogOption {
    pub kind: OptionKind,
    /// Index into the registry row's `remotes` or `packages`.
    pub index: usize,
    pub outcome: Result<Launch, McpCatalogReason>,
}

/// Why an item or option is not installable. Wire shape: `{ code, ...detail }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum McpCatalogReason {
    NeedsRuntime {
        runtime: Runner,
    },
    NoInstallOptions,
    Unparseable,
    InsecureUrl,
    LocalNetworkUrl,
    InvalidUrl,
    UnknownRemoteTransport {
        transport: String,
    },
    SecretInUrl,
    SecretInArguments,
    RuntimeArguments,
    RuntimeHintMismatch {
        #[serde(rename = "runtimeHint")]
        runtime_hint: String,
    },
    DeniedEnv {
        name: String,
    },
    InvalidEnvName {
        name: String,
    },
    UnsupportedRegistryType {
        #[serde(rename = "registryType")]
        registry_type: String,
    },
    NonStdioTransport {
        transport: String,
    },
    UnpinnedVersion,
    InvalidPackage,
    /// The row names a registry other than the runner's default, or an OCI
    /// host off the allowlist, so the template would fetch the package from
    /// somewhere other than where the row placed it.
    UnsupportedRegistry {
        registry: String,
    },
}

/// Options in default-preference order: remotes first (streamable-http before
/// sse, then anything else), then packages in registry order.
pub(crate) fn convert(server: &RegistryServer) -> Vec<CatalogOption> {
    let mut remotes: Vec<(usize, &RegistryRemote)> = server.remotes.iter().enumerate().collect();
    remotes.sort_by_key(|(_, remote)| match remote.transport.as_str() {
        "streamable-http" => 0,
        "sse" => 1,
        _ => 2,
    });
    let remote_options = remotes.into_iter().map(|(index, remote)| CatalogOption {
        kind: OptionKind::Remote,
        index,
        outcome: convert_remote(remote),
    });
    let package_options =
        server
            .packages
            .iter()
            .enumerate()
            .map(|(index, package)| CatalogOption {
                kind: OptionKind::Package,
                index,
                outcome: convert_package(package),
            });
    remote_options.chain(package_options).collect()
}

fn convert_remote(remote: &RegistryRemote) -> Result<Launch, McpCatalogReason> {
    let transport = match remote.transport.as_str() {
        "streamable-http" => RemoteTransport::Http,
        "sse" => RemoteTransport::Sse,
        other => {
            return Err(McpCatalogReason::UnknownRemoteTransport {
                transport: other.to_string(),
            })
        }
    };
    if remote
        .variables
        .values()
        .any(RegistryInput::is_secret_anywhere)
    {
        return Err(McpCatalogReason::SecretInUrl);
    }
    check_remote_url(&remote.url)?;
    Ok(Launch::Remote {
        transport,
        url: remote.url.clone(),
    })
}

/// `https` only, and never a loopback or private-network host. Template
/// variables are stood in for, so a templated path still validates; the plan
/// re-checks the resolved URL.
fn check_remote_url(raw: &str) -> Result<(), McpCatalogReason> {
    let filled = fill_template_variables(raw).ok_or(McpCatalogReason::InvalidUrl)?;
    let url = Url::parse(&filled).map_err(|_| McpCatalogReason::InvalidUrl)?;
    if url.scheme() != "https" {
        return Err(McpCatalogReason::InsecureUrl);
    }
    let host = url.host_str().ok_or(McpCatalogReason::InvalidUrl)?;
    if is_local_host(host) {
        return Err(McpCatalogReason::LocalNetworkUrl);
    }
    Ok(())
}

/// `None` when a `{` is never closed.
fn fill_template_variables(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut in_variable = false;
    for ch in raw.chars() {
        match (in_variable, ch) {
            (false, '{') => in_variable = true,
            (true, '}') => {
                in_variable = false;
                out.push('x');
            }
            (false, _) => out.push(ch),
            (true, _) => {}
        }
    }
    (!in_variable).then_some(out)
}

fn is_local_host(host: &str) -> bool {
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    match unbracketed.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_local_ipv4(ip),
        Ok(IpAddr::V6(ip)) => is_local_ipv6(ip),
        Err(_) => {
            let domain = host.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost")
        }
    }
}

fn is_local_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        // 100.64.0.0/10, carrier-grade NAT shared space.
        || (a == 100 && (64..128).contains(&b))
}

fn is_local_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_local_ipv4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        // fc00::/7 unique local, fe80::/10 link local.
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
}

fn convert_package(package: &RegistryPackage) -> Result<Launch, McpCatalogReason> {
    let Some(runner) = Runner::for_registry_type(&package.registry_type) else {
        return Err(McpCatalogReason::UnsupportedRegistryType {
            registry_type: package.registry_type.clone(),
        });
    };
    if let Some(transport) = package.transport.as_ref().filter(|t| t.kind != "stdio") {
        return Err(McpCatalogReason::NonStdioTransport {
            transport: transport.kind.clone(),
        });
    }
    if !package.runtime_arguments.is_empty() {
        return Err(McpCatalogReason::RuntimeArguments);
    }
    if let Some(hint) = package
        .runtime_hint
        .as_deref()
        .filter(|h| *h != runner.runtime_hint())
    {
        return Err(McpCatalogReason::RuntimeHintMismatch {
            runtime_hint: hint.to_string(),
        });
    }
    if package
        .package_arguments
        .iter()
        .any(RegistryInput::is_secret_anywhere)
    {
        return Err(McpCatalogReason::SecretInArguments);
    }
    for env in &package.environment_variables {
        check_env_name(&env.name)?;
    }
    let registry = package
        .registry_base_url
        .as_deref()
        .filter(|url| !url.is_empty());
    if let (Some(url), Some(default)) = (registry, runner.default_registry()) {
        if url.trim_end_matches('/') != default {
            return Err(McpCatalogReason::UnsupportedRegistry {
                registry: url.to_string(),
            });
        }
    }
    let version = package.version.as_deref().filter(|v| !v.is_empty());
    if !is_valid_identifier(runner, &package.identifier)
        || version.is_some_and(|v| !is_valid_version(v))
    {
        return Err(McpCatalogReason::InvalidPackage);
    }
    let id = &package.identifier;
    let argv = match runner {
        Runner::Npx => {
            let version = pinned(version, &NPM_VERSION)?;
            if NPM_FILE_SPEC.is_match(version) {
                return Err(McpCatalogReason::InvalidPackage);
            }
            vec!["-y".to_string(), format!("{id}@{version}")]
        }
        Runner::Uvx => vec![format!("{id}@{}", pinned(version, &PYPI_VERSION)?)],
        Runner::Dotnet => vec![
            "dnx".to_string(),
            format!("{id}@{}", pinned(version, &NUGET_VERSION)?),
            "--yes".to_string(),
        ],
        Runner::Docker => {
            let image = pinned_oci_image(id, version, registry)?;
            let mut argv: Vec<String> = ["run", "-i", "--rm"].map(String::from).into();
            for env in &package.environment_variables {
                argv.push("-e".to_string());
                argv.push(env.name.clone());
            }
            argv.push(image);
            argv
        }
    };
    Ok(Launch::Stdio {
        runner,
        argv: std::iter::once(runner.command().to_string())
            .chain(argv)
            .collect(),
    })
}

/// A name the runner reads from its own environment can redirect what it
/// runs (`NODE_OPTIONS=--require`, `npm_config_registry`, `UV_INDEX_URL`), so
/// a package declaring one is unsupported. Matched case-insensitively.
const DENIED_ENV_NAMES: &[&str] = &["NODE_OPTIONS", "NODE_PATH", "PATH", "PATHEXT", "COMSPEC"];
const DENIED_ENV_PREFIXES: &[&str] = &[
    "NPM_CONFIG_",
    "UV_",
    "PIP_",
    "PYTHON",
    "DOCKER_",
    "LD_",
    "DYLD_",
    "DOTNET_",
    "NUGET_",
];

#[must_use]
pub(crate) fn is_denied_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    DENIED_ENV_NAMES.contains(&upper.as_str())
        || DENIED_ENV_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
}

/// An env name becomes a docker `-e` argv element, so it must be a plain
/// identifier (`-e NAME=value` would smuggle a value in from registry text).
fn check_env_name(name: &str) -> Result<(), McpCatalogReason> {
    static ENV_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$").expect("env name regex"));
    if !ENV_NAME.is_match(name) {
        return Err(McpCatalogReason::InvalidEnvName {
            name: name.to_string(),
        });
    }
    if is_denied_env_name(name) {
        return Err(McpCatalogReason::DeniedEnv {
            name: name.to_string(),
        });
    }
    Ok(())
}

/// The package grammar, per runner. Each admits only a name the runner reads
/// as a package on its registry, never a URL, path, VCS or alias spec
/// (`https://h/p.tgz`, `file:../x`, `git+https://h/r`, `github:u/r`,
/// `npm:other`), so `<id>@<version>` always resolves the pinned registry
/// package. None admits a leading `-` or a cmd metacharacter, on any host.
#[must_use]
pub(crate) fn is_valid_identifier(runner: Runner, identifier: &str) -> bool {
    static NPM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$").expect("npm name regex")
    });
    static PYPI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$").expect("pypi name regex")
    });
    static NUGET: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").expect("nuget id regex"));
    let (grammar, max_len) = match runner {
        Runner::Npx if NPM_FILE_SPEC.is_match(identifier) => return false,
        Runner::Npx => (&*NPM, 214),
        Runner::Uvx => (&*PYPI, 255),
        Runner::Dotnet => (&*NUGET, 100),
        Runner::Docker => return parse_oci_reference(identifier).is_some(),
    };
    identifier.len() <= max_len && grammar.is_match(identifier)
}

/// An OCI image reference. `host` is `None` for a Docker Hub short name.
struct OciReference<'a> {
    host: Option<&'a str>,
    tag: Option<&'a str>,
    digest: bool,
}

/// `[host[:port]/]component(/component)*[:tag][@sha256:<64 hex>]`, with
/// lowercase components. The first component is a host when it holds a `.`
/// or `:` or is `localhost`, as the docker CLI reads it.
fn parse_oci_reference(identifier: &str) -> Option<OciReference<'_>> {
    static HOST: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$")
            .expect("oci host regex")
    });
    static REPOSITORY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(concat!(
            r"^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*",
            r"(:(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?P<digest>@sha256:[0-9a-f]{64})?$",
        ))
        .expect("oci repository regex")
    });
    if identifier.len() > 255 {
        return None;
    }
    let (host, rest) = match identifier.split_once('/') {
        Some((first, rest)) if first.contains(['.', ':']) || first == "localhost" => {
            (Some(first), rest)
        }
        _ => (None, identifier),
    };
    if host.is_some_and(|host| !HOST.is_match(host)) {
        return None;
    }
    let captures = REPOSITORY.captures(rest)?;
    Some(OciReference {
        host,
        tag: captures.name("tag").map(|tag| tag.as_str()),
        digest: captures.name("digest").is_some(),
    })
}

/// The OCI registries the official MCP Registry accepts images from.
fn is_allowed_oci_host(host: &str) -> bool {
    let name = host.split_once(':').map_or(host, |(name, _)| name);
    matches!(
        name,
        "docker.io" | "ghcr.io" | "quay.io" | "mcr.microsoft.com"
    ) || name.ends_with(".pkg.dev")
        || name.ends_with(".azurecr.io")
}

#[must_use]
pub(crate) fn is_valid_version(version: &str) -> bool {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9.+_~-]{0,127}$").expect("version regex")
    });
    VERSION.is_match(version)
}

static NPM_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$").expect("npm version regex")
});
/// npm reads a name or version ending in a tarball extension as a local file
/// (`pkg@1.0.0-a.tgz` installs `./1.0.0-a.tgz`), as `npm-package-arg` does.
static NPM_FILE_SPEC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(tgz|tar\.gz|tar)$").expect("npm file spec regex"));
static PYPI_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^v?\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?(\+[a-z0-9.]+)?$")
        .expect("pypi version regex")
});
static NUGET_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")
        .expect("nuget version regex")
});

fn pinned<'a>(version: Option<&'a str>, rule: &Regex) -> Result<&'a str, McpCatalogReason> {
    version
        .filter(|v| rule.is_match(v))
        .ok_or(McpCatalogReason::UnpinnedVersion)
}

/// An OCI image is pinned by an `@sha256:` digest or a tag other than
/// `latest`. Older schemas put the tag in `version`, so a bare identifier
/// takes it from there. The image's registry is its host (Docker Hub when it
/// names none), which must be on the allowlist and equal the host of any
/// `registryBaseUrl` the row names.
fn pinned_oci_image(
    identifier: &str,
    version: Option<&str>,
    registry_base_url: Option<&str>,
) -> Result<String, McpCatalogReason> {
    let reference = parse_oci_reference(identifier).ok_or(McpCatalogReason::InvalidPackage)?;
    let host = reference.host.unwrap_or("docker.io");
    if !is_allowed_oci_host(host) {
        return Err(McpCatalogReason::UnsupportedRegistry {
            registry: host.to_string(),
        });
    }
    if let Some(url) = registry_base_url {
        let base_host = Url::parse(url).ok().and_then(|base| {
            let name = base.host_str()?;
            Some(base.port().map_or_else(|| name.to_string(), |port| format!("{name}:{port}")))
        });
        if base_host.as_deref() != Some(host) {
            return Err(McpCatalogReason::UnsupportedRegistry {
                registry: url.to_string(),
            });
        }
    }
    if reference.digest {
        return Ok(identifier.to_string());
    }
    let (image, tag) = match reference.tag {
        Some(tag) => (identifier.to_string(), Some(tag)),
        None => (
            version.map_or_else(|| identifier.to_string(), |v| format!("{identifier}:{v}")),
            version,
        ),
    };
    match tag {
        Some(tag) if tag != "latest" => {
            if parse_oci_reference(&image).is_some() {
                Ok(image)
            } else {
                Err(McpCatalogReason::InvalidPackage)
            }
        }
        _ => Err(McpCatalogReason::UnpinnedVersion),
    }
}

/// Catalog rows can reach a remote browser, so a repository link passes the
/// AD-15 guard as remote-opened (`https` only) or is dropped.
#[must_use]
pub(crate) fn safe_repository_url(raw: &str) -> Option<String> {
    check_safe_url(raw, Opener::Remote).ok().map(String::from)
}
