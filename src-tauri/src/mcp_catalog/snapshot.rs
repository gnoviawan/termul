//! The bundled registry snapshot (AD-3). Dev and test builds embed the
//! committed fixture in `resources/mcp-registry/`, whose metadata marks it as
//! a sample; the release workflow overwrites those two files with the full
//! fetch from its secret-less snapshot job before `cargo build`. Loading
//! verifies the recorded sha256, and any failure leaves an empty catalog
//! rather than a panic.

use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;

use flate2::read::GzDecoder;
use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::convert::{convert, safe_repository_url, CatalogOption, RegistryServer};

const EMBEDDED_SNAPSHOT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/mcp-registry/mcp-registry-snapshot.json.gz"
));
const EMBEDDED_META: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/mcp-registry/mcp-registry-snapshot.meta.json"
));

const SNAPSHOT_FORMAT_VERSION: u32 = 1;
const MAX_SNAPSHOT_JSON_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const OFFICIAL_META: &str = "io.modelcontextprotocol.registry/official";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistryStatus {
    Active,
    Deprecated,
}

/// One browsable catalog item: the registry row whose version is latest and
/// not deleted (AD-2).
#[derive(Debug, Clone)]
pub(crate) struct CatalogItem {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: String,
    pub status: RegistryStatus,
    pub repository_url: Option<String>,
    /// `None` when the row did not parse: the item shows as unsupported.
    pub options: Option<Vec<CatalogOption>>,
}

/// Which registry data a catalog holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogSource {
    /// When its newest registry data was fetched.
    pub updated_at: Option<String>,
    /// The committed dev/test fixture rather than the full registry.
    pub sample: bool,
}

#[derive(Debug, Default)]
pub(crate) struct LoadedCatalog {
    /// Sorted by name, one per name.
    pub items: Vec<CatalogItem>,
    pub source: McpCatalogSource,
}

impl LoadedCatalog {
    /// A catalog of exactly `items`, in any order.
    pub(crate) fn from_items(items: Vec<CatalogItem>, source: McpCatalogSource) -> Self {
        Self::default().with_changes(
            items
                .into_iter()
                .map(|item| (item.name.clone(), Some(item))),
            source,
        )
    }

    /// This catalog with each named item replaced, added, or (`None`) removed.
    pub(crate) fn with_changes(
        &self,
        changes: impl IntoIterator<Item = (String, Option<CatalogItem>)>,
        source: McpCatalogSource,
    ) -> Self {
        let mut items: BTreeMap<String, CatalogItem> = self
            .items
            .iter()
            .map(|item| (item.name.clone(), item.clone()))
            .collect();
        for (name, item) in changes {
            match item {
                Some(item) => items.insert(name, item),
                None => items.remove(&name),
            };
        }
        Self {
            items: items.into_values().collect(),
            source,
        }
    }
}

#[derive(Debug)]
pub(crate) enum SnapshotError {
    Meta(serde_json::Error),
    Checksum,
    Decompress(std::io::Error),
    TooLarge,
    Json(serde_json::Error),
    FormatVersion(u32),
    Empty,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Meta(error) => write!(f, "snapshot metadata is invalid: {error}"),
            Self::Checksum => f.write_str("snapshot sha256 does not match its metadata"),
            Self::Decompress(error) => write!(f, "snapshot does not decompress: {error}"),
            Self::TooLarge => write!(f, "snapshot exceeds {MAX_SNAPSHOT_JSON_BYTES} bytes"),
            Self::Json(error) => write!(f, "snapshot JSON is invalid: {error}"),
            Self::FormatVersion(version) => write!(f, "snapshot format {version} is not supported"),
            Self::Empty => f.write_str("snapshot has no servers"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    sha256: String,
    fetched_at: String,
    #[serde(default)]
    sample: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    format_version: u32,
    #[serde(deserialize_with = "deserialize_items")]
    servers: Vec<CatalogItem>,
}

pub(crate) fn load_embedded() -> LoadedCatalog {
    load_or_empty(EMBEDDED_SNAPSHOT, EMBEDDED_META)
}

pub(crate) fn load_or_empty(gz: &[u8], meta: &str) -> LoadedCatalog {
    match load(gz, meta) {
        Ok(catalog) => {
            let unparseable = catalog
                .items
                .iter()
                .filter(|item| item.options.is_none())
                .count();
            log::info!(
                "[mcp-catalog] snapshot loaded items={} unparseable={} fetched_at={} sample={}",
                catalog.items.len(),
                unparseable,
                catalog.source.updated_at.as_deref().unwrap_or(""),
                catalog.source.sample
            );
            catalog
        }
        Err(error) => {
            log::error!("[mcp-catalog] snapshot load failed, serving an empty catalog: {error}");
            LoadedCatalog::default()
        }
    }
}

pub(crate) fn load(gz: &[u8], meta: &str) -> Result<LoadedCatalog, SnapshotError> {
    let meta: SnapshotMeta = serde_json::from_str(meta).map_err(SnapshotError::Meta)?;
    if !format!("{:x}", Sha256::digest(gz)).eq_ignore_ascii_case(meta.sha256.trim()) {
        return Err(SnapshotError::Checksum);
    }
    let mut json = Vec::new();
    GzDecoder::new(gz)
        .take(MAX_SNAPSHOT_JSON_BYTES + 1)
        .read_to_end(&mut json)
        .map_err(SnapshotError::Decompress)?;
    if json.len() as u64 > MAX_SNAPSHOT_JSON_BYTES {
        return Err(SnapshotError::TooLarge);
    }
    let file: SnapshotFile = serde_json::from_slice(&json).map_err(SnapshotError::Json)?;
    if file.format_version != SNAPSHOT_FORMAT_VERSION {
        return Err(SnapshotError::FormatVersion(file.format_version));
    }
    let mut items = file.servers;
    if items.is_empty() {
        return Err(SnapshotError::Empty);
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items.dedup_by(|a, b| a.name == b.name);
    Ok(LoadedCatalog {
        items,
        source: McpCatalogSource {
            updated_at: Some(meta.fetched_at),
            sample: meta.sample,
        },
    })
}

/// Converts each row as it is read, so the full catalog is never held as a
/// JSON tree.
fn deserialize_items<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<CatalogItem>, D::Error> {
    struct Rows;
    impl<'de> Visitor<'de> for Rows {
        type Value = Vec<CatalogItem>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an array of registry rows")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(row) = seq.next_element::<Value>()? {
                items.extend(item_from_row(row));
            }
            Ok(items)
        }
    }
    deserializer.deserialize_seq(Rows)
}

/// `None` for rows that never browse: not latest, deleted, or nameless.
pub(crate) fn item_from_row(mut row: Value) -> Option<CatalogItem> {
    let official = &row["_meta"][OFFICIAL_META];
    if official["isLatest"].as_bool() != Some(true) {
        return None;
    }
    let status = match official["status"].as_str() {
        Some("deleted") => return None,
        Some("deprecated") => RegistryStatus::Deprecated,
        _ => RegistryStatus::Active,
    };
    let server = row.get_mut("server").map(Value::take)?;
    let name = server["name"]
        .as_str()
        .filter(|name| !name.is_empty())?
        .to_string();
    let text = |key: &str| server[key].as_str().map(str::to_string);
    let (title, description, version) = (text("title"), text("description"), text("version"));
    Some(match RegistryServer::deserialize(server) {
        Ok(parsed) => CatalogItem {
            options: Some(convert(&parsed)),
            repository_url: parsed
                .repository
                .and_then(|repository| repository.url)
                .and_then(|url| safe_repository_url(&url)),
            name,
            title: parsed.title,
            description: parsed.description,
            version: parsed.version,
            status,
        },
        Err(_) => CatalogItem {
            name,
            title,
            description: description.unwrap_or_default(),
            version: version.unwrap_or_default(),
            status,
            repository_url: None,
            options: None,
        },
    })
}
