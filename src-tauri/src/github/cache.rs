//! Read cache and GraphQL quota reserve, shared by every transport so the
//! desktop, its shared-live clients and polling all reuse one set of reads.

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::graphql::RateBudget;
use super::types::GithubRepoRef;

pub(super) const READ_TTL: Duration = Duration::from_secs(30);
/// Below this share of the hourly GraphQL budget, reads come from the cache
/// until the budget resets, leaving the rest to the user's agents.
const RESERVE_FRACTION: f64 = 0.4;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct CacheKey {
    pub repo: GithubRepoRef,
    /// The op and its arguments, e.g. `checks:42`.
    pub op: String,
}

struct Entry {
    stored: Instant,
    value: Arc<dyn Any + Send + Sync>,
}

#[derive(Default)]
pub(super) struct ReadCache {
    entries: Mutex<HashMap<CacheKey, Entry>>,
}

impl ReadCache {
    /// The cached value no older than `max_age` (`None`: any age).
    pub fn get<T: Clone + Send + Sync + 'static>(
        &self,
        key: &CacheKey,
        max_age: Option<Duration>,
    ) -> Option<T> {
        let entries = self.entries.lock();
        let entry = entries.get(key)?;
        if max_age.is_some_and(|max| entry.stored.elapsed() > max) {
            return None;
        }
        entry.value.downcast_ref::<T>().cloned()
    }

    pub fn put<T: Send + Sync + 'static>(&self, key: CacheKey, value: T) {
        let mut entries = self.entries.lock();
        // Drop long-dead entries so a long session doesn't grow without bound.
        entries.retain(|_, entry| entry.stored.elapsed() < READ_TTL * 20);
        entries.insert(
            key,
            Entry {
                stored: Instant::now(),
                value: Arc::new(value),
            },
        );
    }

    pub fn invalidate_repo(&self, repo: &GithubRepoRef) {
        self.entries.lock().retain(|key, _| key.repo != *repo);
    }
}

/// Per host: reads are served from the cache until this time.
#[derive(Default)]
pub(super) struct QuotaReserve {
    until: Mutex<HashMap<String, chrono::DateTime<chrono::Utc>>>,
}

impl QuotaReserve {
    pub fn observe(&self, host: &str, budget: &RateBudget) {
        if budget.limit == 0 {
            return;
        }
        let low = (budget.remaining as f64) < (budget.limit as f64) * RESERVE_FRACTION;
        let mut until = self.until.lock();
        if !low {
            if until.remove(host).is_some() {
                log::info!(
                    "[github] leaving quota reserve on {host}: {}/{} GraphQL points left",
                    budget.remaining,
                    budget.limit
                );
            }
            return;
        }
        let Ok(reset) = chrono::DateTime::parse_from_rfc3339(&budget.reset_at) else {
            return;
        };
        if until
            .insert(host.to_string(), reset.with_timezone(&chrono::Utc))
            .is_none()
        {
            log::warn!(
                "[github] entering quota reserve on {host}: {}/{} GraphQL points left; \
                 serving cached reads until {}",
                budget.remaining,
                budget.limit,
                budget.reset_at
            );
        }
    }

    pub fn active(&self, host: &str) -> bool {
        let mut until = self.until.lock();
        match until.get(host) {
            Some(reset) if chrono::Utc::now() < *reset => true,
            Some(_) => {
                until.remove(host);
                log::info!("[github] leaving quota reserve on {host}: budget reset");
                false
            }
            None => false,
        }
    }
}
