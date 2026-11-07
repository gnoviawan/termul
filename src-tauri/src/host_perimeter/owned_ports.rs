//! Loopback ports this process listens on. Tab navigation to any of them is
//! denied. Each listener holds an [`OwnedPort`] for as long as it serves.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// Port to live claim count. A count, not a set, because an OS can hand a
/// released port to a new listener before the old guard drops.
static OWNED: Mutex<BTreeMap<u16, usize>> = Mutex::new(BTreeMap::new());

fn owned() -> std::sync::MutexGuard<'static, BTreeMap<u16, usize>> {
    OWNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Marks a port as termul-owned until dropped.
#[derive(Debug)]
#[must_use = "the port stops being owned when the guard drops"]
pub(crate) struct OwnedPort(u16);

impl OwnedPort {
    pub(crate) fn claim(port: u16) -> Self {
        if port != 0 {
            *owned().entry(port).or_insert(0) += 1;
        }
        Self(port)
    }
}

impl Drop for OwnedPort {
    fn drop(&mut self) {
        let mut ports = owned();
        if let Some(count) = ports.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                ports.remove(&self.0);
            }
        }
    }
}

/// For listeners that live as long as the process.
pub(crate) fn claim_for_process(port: u16) {
    std::mem::forget(OwnedPort::claim(port));
}

pub(crate) fn is_owned(port: u16) -> bool {
    owned().contains_key(&port)
}

/// Every owned port, for checks that take the whole set.
pub(crate) fn owned_list() -> Vec<u16> {
    owned().keys().copied().collect()
}
