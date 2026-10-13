//! Partition bookkeeping (issue #1073): last-seen tracking, the stale-partition
//! sweep and the per-device byte budget.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::{info, warn};

use super::records::record_bytes;
use super::scope::{device_prefix, partition_of};
use super::{State, WebStore};
use crate::web::presence::PresenceRegistry;

/// How often the host sweeps for stale partitions.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Longest a last-seen update stays memory-only while requests keep coming.
pub const LAST_SEEN_FLUSH_MS: u64 = 60 * 60 * 1000;

impl State {
    /// Record that `device_id` was seen at `now_ms`. Memory only; the next
    /// write, or [`LAST_SEEN_FLUSH_MS`], persists it.
    pub(super) fn touch(&mut self, device_id: &str, now_ms: u64) {
        if device_prefix(device_id).is_none() {
            return;
        }
        let seen = self.host.last_seen.entry(device_id.to_string()).or_insert(0);
        if *seen < now_ms {
            *seen = now_ms;
            self.last_seen_dirty = true;
        }
    }

    /// Serialized bytes of every record under `prefix` (`device/<id>/`).
    pub(super) fn partition_bytes(&self, prefix: &str) -> usize {
        self.data
            .range(prefix.to_string()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, record)| record_bytes(key, record))
            .sum()
    }

    /// Devices holding a partition, plus devices only known by last-seen.
    fn known_devices(&self) -> HashSet<String> {
        self.data
            .range("device/".to_string()..)
            .take_while(|(key, _)| key.starts_with("device/"))
            .filter_map(|(key, _)| partition_of(key))
            .map(str::to_string)
            .chain(self.host.last_seen.keys().cloned())
            .collect()
    }

    /// Drop every key of `device_id`'s partition.
    fn remove_partition(&mut self, device_id: &str) {
        let Some(prefix) = device_prefix(device_id) else {
            return;
        };
        let keys: Vec<String> = self
            .data
            .range(prefix.clone()..)
            .take_while(|(key, _)| key.starts_with(&prefix))
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            self.data.remove(&key);
        }
    }

    /// The sweep decision: devices to collect and devices whose last-seen is
    /// unknown (to initialise). Present devices are never collected.
    pub(super) fn plan_sweep(
        &self,
        now_ms: u64,
        present: &HashSet<String>,
        gc_age_ms: u64,
    ) -> (Vec<String>, Vec<String>) {
        let mut collect = Vec::new();
        let mut init = Vec::new();
        for device in self.known_devices() {
            if present.contains(&device) {
                continue;
            }
            match self.host.last_seen.get(&device) {
                None => init.push(device),
                Some(seen) if now_ms.saturating_sub(*seen) > gc_age_ms => collect.push(device),
                Some(_) => {}
            }
        }
        collect.sort();
        init.sort();
        (collect, init)
    }

    /// Apply a sweep plan to the state.
    pub(super) fn apply_sweep(
        &mut self,
        now_ms: u64,
        present: &HashSet<String>,
        collect: &[String],
        init: &[String],
    ) {
        for device in present {
            self.touch(device, now_ms);
        }
        for device in init {
            self.host.last_seen.insert(device.clone(), now_ms);
        }
        for device in collect {
            self.remove_partition(device);
            self.host.last_seen.remove(device);
        }
    }
}

impl WebStore {
    /// Collect the partitions of devices unseen for longer than the policy's
    /// GC age and not in `present`; a device with unknown last-seen starts its
    /// clock at `now_ms`. Devices in `present` are marked seen. Returns the
    /// collected device ids.
    pub fn sweep(
        &self,
        now_ms: u64,
        present: &HashSet<String>,
    ) -> Result<Vec<String>, super::StoreError> {
        self.with_state(|state| {
            let (collect, init) = state.plan_sweep(now_ms, present, self.policy.gc_age_ms());
            if collect.is_empty() && init.is_empty() {
                state.apply_sweep(now_ms, present, &[], &[]);
                return Ok(Vec::new());
            }
            let mut next = state.clone();
            next.apply_sweep(now_ms, present, &collect, &init);
            next.persist(&self.path, &self.extra, now_ms)?;
            *state = next;
            Ok(collect)
        })
    }

    /// Note that `device_id` was seen at `now_ms` (memory only, see
    /// [`State::touch`]). A store request does this itself.
    pub fn touch(&self, device_id: &str, now_ms: u64) {
        if let Some(state) = self.inner.lock().as_mut() {
            state.touch(device_id, now_ms);
        }
    }
}

/// Sweep once now, then every [`SWEEP_INTERVAL`], skipping devices currently
/// connected. The caller aborts the task when the host stops.
#[must_use]
pub fn spawn_gc_task(store: Arc<WebStore>, presence: Arc<PresenceRegistry>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let (store, present) = (Arc::clone(&store), presence.device_ids());
            let result = tokio::task::spawn_blocking(move || {
                store.sweep(super::unix_ms(), &present)
            })
            .await;
            match result {
                Ok(Ok(collected)) if !collected.is_empty() => info!(
                    target: "termul::web::store",
                    collected = collected.len(),
                    "web store sweep collected stale device partitions"
                ),
                Ok(Ok(_)) => {}
                Ok(Err(error)) => warn!(
                    target: "termul::web::store",
                    "web store sweep failed: {error}"
                ),
                Err(error) => warn!(
                    target: "termul::web::store",
                    "web store sweep task failed: {error}"
                ),
            }
        }
    })
}
