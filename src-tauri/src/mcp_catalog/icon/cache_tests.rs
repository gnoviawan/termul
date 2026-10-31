use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use url::Url;

use super::cache::{key, Entry, FetchIcon, IconCache, IconUnavailable, FAILED_TTL, FRESH_TTL};
use super::fetch::FetchError;
use super::{Icon, IconSource, IconType};

const START: u64 = 1_800_000_000;

struct Harness {
    clock: Arc<AtomicU64>,
    fetches: Arc<AtomicUsize>,
}

impl Harness {
    fn advance(&self, by: Duration) {
        self.clock.fetch_add(by.as_secs(), Ordering::SeqCst);
    }

    fn fetches(&self) -> usize {
        self.fetches.load(Ordering::SeqCst)
    }
}

fn icon_for(url: &Url, len: usize) -> Icon {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(url.as_str().bytes());
    bytes.resize(len.max(bytes.len()), 0);
    Icon {
        content_type: IconType::Png,
        bytes: bytes.into(),
    }
}

fn cache(dir: &Path, max_bytes: u64, len: usize, delay: Duration) -> (Arc<IconCache>, Harness) {
    let clock = Arc::new(AtomicU64::new(START));
    let fetches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&fetches);
    let fetch: FetchIcon = Arc::new(move |url: Url| {
        counted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            if url.path().contains("fail") {
                Err(FetchError::Status(500))
            } else {
                Ok(icon_for(&url, len))
            }
        })
    });
    let now = Arc::clone(&clock);
    let cache = IconCache::with(
        dir.to_path_buf(),
        fetch,
        Arc::new(move || UNIX_EPOCH + Duration::from_secs(now.load(Ordering::SeqCst))),
        max_bytes,
    );
    (Arc::new(cache), Harness { clock, fetches })
}

fn source(url: &str) -> IconSource {
    IconSource(Url::parse(url).unwrap())
}

#[tokio::test]
async fn a_cached_icon_is_served_without_fetching_again_even_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let logo = source("https://a.example/logo.png");
    let (first, harness) = cache(dir.path(), u64::MAX, 0, Duration::ZERO);
    let icon = first.icon(&logo).await.unwrap();
    assert_eq!(icon, icon_for(logo.url(), 0));
    assert_eq!(first.icon(&logo).await.unwrap(), icon);
    assert_eq!(harness.fetches(), 1);

    let (restarted, harness) = cache(dir.path(), u64::MAX, 0, Duration::ZERO);
    assert_eq!(restarted.icon(&logo).await.unwrap(), icon);
    assert_eq!(harness.fetches(), 0);
    assert!(dir.path().join(key(logo.url())).is_file());
}

#[tokio::test]
async fn an_icon_is_fetched_again_once_it_is_seven_days_old() {
    let dir = tempfile::tempdir().unwrap();
    let logo = source("https://a.example/logo.png");
    let (cache, harness) = cache(dir.path(), u64::MAX, 0, Duration::ZERO);
    cache.icon(&logo).await.unwrap();
    harness.advance(FRESH_TTL - Duration::from_secs(1));
    cache.icon(&logo).await.unwrap();
    assert_eq!(harness.fetches(), 1);
    harness.advance(Duration::from_secs(1));
    cache.icon(&logo).await.unwrap();
    assert_eq!(harness.fetches(), 2);
}

#[tokio::test]
async fn a_failure_is_remembered_for_a_day() {
    let dir = tempfile::tempdir().unwrap();
    let broken = source("https://a.example/fail.png");
    let (cache, harness) = cache(dir.path(), u64::MAX, 0, Duration::ZERO);
    assert_eq!(cache.icon(&broken).await, Err(IconUnavailable));
    harness.advance(FAILED_TTL - Duration::from_secs(1));
    assert_eq!(cache.icon(&broken).await, Err(IconUnavailable));
    assert_eq!(harness.fetches(), 1);
    harness.advance(Duration::from_secs(1));
    assert_eq!(cache.icon(&broken).await, Err(IconUnavailable));
    assert_eq!(harness.fetches(), 2);
    let entry = std::fs::read(dir.path().join(key(broken.url()))).unwrap();
    assert_eq!(
        Entry::decode(&entry),
        Some(Entry::Failed {
            at: UNIX_EPOCH + Duration::from_secs(START) + FAILED_TTL
        })
    );
}

#[tokio::test]
async fn concurrent_requests_for_one_icon_share_one_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let logo = source("https://a.example/logo.png");
    let other = source("https://b.example/logo.png");
    let (cache, harness) = cache(dir.path(), u64::MAX, 0, Duration::from_millis(100));
    let requests: Vec<_> = (0..8)
        .map(|index| {
            let cache = Arc::clone(&cache);
            let source = if index < 6 {
                logo.clone()
            } else {
                other.clone()
            };
            tokio::spawn(async move { cache.icon(&source).await })
        })
        .collect();
    for request in requests {
        assert!(request.await.unwrap().is_ok());
    }
    assert_eq!(harness.fetches(), 2);
}

#[tokio::test]
async fn a_fetch_finishes_and_is_cached_when_its_caller_goes_away() {
    let dir = tempfile::tempdir().unwrap();
    let logo = source("https://a.example/logo.png");
    let (cache, harness) = cache(dir.path(), u64::MAX, 0, Duration::from_millis(100));
    let abandoned = tokio::time::timeout(Duration::from_millis(10), cache.icon(&logo)).await;
    assert!(abandoned.is_err());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(cache.icon(&logo).await.is_ok());
    assert_eq!(harness.fetches(), 1);
}

#[tokio::test]
async fn an_unreadable_entry_is_fetched_again() {
    let dir = tempfile::tempdir().unwrap();
    let logo = source("https://a.example/logo.png");
    std::fs::write(dir.path().join(key(logo.url())), b"not an entry").unwrap();
    let (cache, harness) = cache(dir.path(), u64::MAX, 0, Duration::ZERO);
    assert!(cache.icon(&logo).await.is_ok());
    assert_eq!(harness.fetches(), 1);
}

fn cached_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum()
}

#[tokio::test]
async fn the_oldest_icons_are_evicted_once_the_cache_passes_its_cap() {
    let dir = tempfile::tempdir().unwrap();
    let (cache, harness) = cache(dir.path(), 10_000, 3_000, Duration::ZERO);
    let logos: Vec<_> = (0..5)
        .map(|index| source(&format!("https://a.example/{index}.png")))
        .collect();
    for logo in &logos {
        cache.icon(logo).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(cached_bytes(dir.path()) <= 10_000);
    for newest in &logos[3..] {
        assert!(dir.path().join(key(newest.url())).is_file());
    }
    assert!(!dir.path().join(key(logos[0].url())).exists());

    cache.icon(&logos[4]).await.unwrap();
    assert_eq!(harness.fetches(), 5);
    cache.icon(&logos[0]).await.unwrap();
    assert_eq!(harness.fetches(), 6);
}

#[test]
fn entries_round_trip_through_their_file_format() {
    let at = UNIX_EPOCH + Duration::from_secs(START);
    let fresh = Entry::Fresh {
        icon: Icon {
            content_type: IconType::Svg,
            bytes: b"<svg>\n</svg>".to_vec().into(),
        },
        at,
    };
    assert_eq!(Entry::decode(&fresh.encode()), Some(fresh));
    let failed = Entry::Failed { at };
    assert_eq!(failed.encode(), b"termul-icon/1 failed 1800000000\n");
    assert_eq!(Entry::decode(&failed.encode()), Some(failed));
    assert_eq!(Entry::decode(b"termul-icon/1 bmp 1\nxx"), None);
    assert_eq!(Entry::decode(b"termul-icon/2 png 1\nxx"), None);
}
