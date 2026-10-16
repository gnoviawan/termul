//! Bounded memory of resolved ticket ids, shared by the permission and the
//! question rendezvous.

use std::collections::{HashSet, VecDeque};

/// How many resolved ticket ids each rendezvous remembers. A later answer to
/// a remembered id reads `already_resolved`; an older one falls off the end
/// and reads `stale` (bounded so a long-lived host cannot grow without limit).
///
/// Tickets have no timeout, so an id is recorded when it is answered or when
/// its session ends (turn end, close, agent death). Every released ticket adds
/// one id, and a client may come back to a ticket after a long absence, so the
/// memory is four times the old size. An id is about 45 bytes, so the cap costs
/// well under 150 KiB per rendezvous.
pub const RESOLVED_TOMBSTONE_CAPACITY: usize = 1024;

/// Bounded FIFO memory of resolved ticket ids (answered or released).
pub(super) struct Tombstones {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl Tombstones {
    pub(super) fn new() -> Self {
        Self {
            order: VecDeque::new(),
            ids: HashSet::new(),
        }
    }

    pub(super) fn record(&mut self, id: &str) {
        if !self.ids.insert(id.to_string()) {
            return;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > RESOLVED_TOMBSTONE_CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                self.ids.remove(&evicted);
            }
        }
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }
}
