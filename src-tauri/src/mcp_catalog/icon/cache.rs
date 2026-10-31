//! The host's logo cache: one file per source URL under
//! `<state>/mcp-catalog/icons/`, named by the URL's sha256. A file holds a
//! fetched logo or a failure, each with the time it was recorded.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::{BoxFuture, FutureExt, Shared};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use url::Url;

use super::fetch::{self, FetchError, IconClient, Policy};
use super::{Icon, IconSource, IconType};

pub(crate) const FRESH_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub(crate) const FAILED_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub(crate) const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAGIC: &str = "termul-icon/1";

pub(crate) type FetchIcon =
    Arc<dyn Fn(Url) -> BoxFuture<'static, Result<Icon, FetchError>> + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The logo is missing from this host's point of view. The reason was logged
/// where it was learned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IconUnavailable;

type Lookup = Shared<BoxFuture<'static, Result<Icon, IconUnavailable>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Entry {
    Fresh { icon: Icon, at: SystemTime },
    Failed { at: SystemTime },
}

impl Entry {
    fn tag(&self) -> &'static str {
        match self {
            Self::Fresh { icon, .. } => match icon.content_type {
                IconType::Png => "png",
                IconType::Jpeg => "jpeg",
                IconType::Webp => "webp",
                IconType::Gif => "gif",
                IconType::Svg => "svg",
            },
            Self::Failed { .. } => "failed",
        }
    }

    fn at(&self) -> SystemTime {
        match self {
            Self::Fresh { at, .. } | Self::Failed { at } => *at,
        }
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        let secs = self
            .at()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let mut bytes = format!("{MAGIC} {} {secs}\n", self.tag()).into_bytes();
        if let Self::Fresh { icon, .. } = self {
            bytes.extend_from_slice(&icon.bytes);
        }
        bytes
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        let newline = bytes.iter().position(|byte| *byte == b'\n')?;
        let header = std::str::from_utf8(&bytes[..newline]).ok()?;
        let mut fields = header.split(' ');
        if fields.next() != Some(MAGIC) {
            return None;
        }
        let tag = fields.next()?;
        let at = UNIX_EPOCH + Duration::from_secs(fields.next()?.parse().ok()?);
        let content_type = match tag {
            "failed" => return Some(Self::Failed { at }),
            "png" => IconType::Png,
            "jpeg" => IconType::Jpeg,
            "webp" => IconType::Webp,
            "gif" => IconType::Gif,
            "svg" => IconType::Svg,
            _ => return None,
        };
        Some(Self::Fresh {
            icon: Icon {
                content_type,
                bytes: bytes[newline + 1..].into(),
            },
            at,
        })
    }

    fn is_current(&self, now: SystemTime) -> bool {
        let ttl = match self {
            Self::Fresh { .. } => FRESH_TTL,
            Self::Failed { .. } => FAILED_TTL,
        };
        now.duration_since(self.at()).is_ok_and(|age| age < ttl)
    }
}

pub(crate) fn key(url: &Url) -> String {
    format!("{:x}", Sha256::digest(url.as_str().as_bytes()))
}

fn is_key(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) struct IconCache {
    dir: PathBuf,
    fetch: FetchIcon,
    now: Clock,
    max_bytes: u64,
    /// One lookup per key at a time; later callers await the same one.
    in_flight: Mutex<HashMap<String, Lookup>>,
    /// Bytes on disk, counted on the first write.
    total: Mutex<Option<u64>>,
}

impl IconCache {
    pub(crate) fn new(dir: PathBuf) -> reqwest::Result<Self> {
        let client = Arc::new(IconClient::new(
            Policy::PUBLIC_HTTPS,
            fetch::system_lookup(),
        )?);
        let fetch: FetchIcon = Arc::new(move |url| {
            let client = Arc::clone(&client);
            Box::pin(async move { client.fetch(&url).await })
        });
        Ok(Self::with(dir, fetch, Arc::new(SystemTime::now), MAX_CACHE_BYTES))
    }

    pub(crate) fn with(dir: PathBuf, fetch: FetchIcon, now: Clock, max_bytes: u64) -> Self {
        Self {
            dir,
            fetch,
            now,
            max_bytes,
            in_flight: Mutex::new(HashMap::new()),
            total: Mutex::new(None),
        }
    }

    pub(crate) async fn icon(self: &Arc<Self>, source: &IconSource) -> Result<Icon, IconUnavailable> {
        let key = key(source.url());
        let lookup = self
            .in_flight
            .lock()
            .entry(key.clone())
            .or_insert_with(|| {
                // Spawned so a caller that goes away mid-fetch doesn't leave
                // the fetch half done for the next caller to resume.
                let task = tokio::spawn({
                    let cache = Arc::clone(self);
                    let source = source.clone();
                    let key = key.clone();
                    async move {
                        let outcome = cache.lookup(&key, &source).await;
                        cache.in_flight.lock().remove(&key);
                        outcome
                    }
                });
                async move { task.await.unwrap_or(Err(IconUnavailable)) }
                    .boxed()
                    .shared()
            })
            .clone();
        lookup.await
    }

    async fn lookup(self: &Arc<Self>, key: &str, source: &IconSource) -> Result<Icon, IconUnavailable> {
        let now = (self.now)();
        let path = self.dir.join(key);
        let cached = tokio::task::spawn_blocking(move || fs::read(path).ok())
            .await
            .ok()
            .flatten()
            .and_then(|bytes| Entry::decode(&bytes))
            .filter(|entry| entry.is_current(now));
        match cached {
            Some(Entry::Fresh { icon, .. }) => return Ok(icon),
            Some(Entry::Failed { .. }) => return Err(IconUnavailable),
            None => {}
        }
        let short_key = &key[..12];
        let outcome = (self.fetch)(source.url().clone()).await;
        let entry = match &outcome {
            Ok(icon) => {
                log::info!(
                    "[mcp-catalog] icon fetched key={short_key} host={} type={} bytes={}",
                    source.host(),
                    icon.content_type.mime(),
                    icon.bytes.len()
                );
                Entry::Fresh {
                    icon: icon.clone(),
                    at: now,
                }
            }
            Err(error) => {
                log::warn!(
                    "[mcp-catalog] icon fetch failed key={short_key} host={}: {error}",
                    source.host()
                );
                Entry::Failed { at: now }
            }
        };
        let cache = Arc::clone(self);
        let key = key.to_string();
        let stored = tokio::task::spawn_blocking(move || cache.store(&key, &entry)).await;
        if let Ok(Err(error)) | Err(error) = stored.map_err(io::Error::other) {
            log::warn!("[mcp-catalog] icon cache write failed key={short_key}: {error}");
        }
        outcome.map_err(|_| IconUnavailable)
    }

    /// Blocking. Writes the entry, then evicts the oldest files once the cache
    /// passes its cap, down to three quarters of it.
    fn store(&self, key: &str, entry: &Entry) -> io::Result<()> {
        let path = self.dir.join(key);
        let previous = fs::metadata(&path).map_or(0, |metadata| metadata.len());
        let bytes = entry.encode();
        crate::acp::atomic_file::replace(&path, &bytes)?;
        let mut total = self.total.lock();
        let total = match total.as_mut() {
            Some(total) => {
                *total = (*total + bytes.len() as u64).saturating_sub(previous);
                total
            }
            None => total.insert(cache_files(&self.dir)?.iter().map(|file| file.len).sum()),
        };
        if *total > self.max_bytes {
            let evicted = evict(&self.dir, key, total, self.max_bytes / 4 * 3)?;
            log::info!("[mcp-catalog] icon cache evicted files={evicted} bytes={total}");
        }
        Ok(())
    }
}

struct CacheFile {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
}

fn cache_files(dir: &Path) -> io::Result<Vec<CacheFile>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_name().to_str().is_some_and(is_key) {
            continue;
        }
        let metadata = entry.metadata()?;
        files.push(CacheFile {
            path: entry.path(),
            len: metadata.len(),
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
        });
    }
    Ok(files)
}

/// Removes the least recently written files, never `keep`, until `total` is
/// at most `target`. Returns how many it removed.
fn evict(dir: &Path, keep: &str, total: &mut u64, target: u64) -> io::Result<usize> {
    let mut files = cache_files(dir)?;
    files.sort_by_key(|file| file.modified);
    let mut evicted = 0;
    for file in files {
        if *total <= target {
            break;
        }
        if file.path.file_name().and_then(|name| name.to_str()) == Some(keep) {
            continue;
        }
        match fs::remove_file(&file.path) {
            Ok(()) => {
                *total = total.saturating_sub(file.len);
                evicted += 1;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(evicted)
}
