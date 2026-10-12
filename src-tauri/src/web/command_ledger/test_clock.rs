//! A hand-advanced [`LedgerClock`] for ledger and `/ws` fault tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::LedgerClock;

/// Starts at zero; only [`ManualClock::advance`] moves it (nanosecond precision).
#[derive(Default)]
pub(crate) struct ManualClock(AtomicU64);

impl ManualClock {
    pub(crate) fn advance(&self, by: Duration) {
        let nanos = u64::try_from(by.as_nanos()).expect("test advance fits in u64 nanoseconds");
        self.0.fetch_add(nanos, Ordering::SeqCst);
    }
}

impl LedgerClock for ManualClock {
    fn now(&self) -> Duration {
        Duration::from_nanos(self.0.load(Ordering::SeqCst))
    }
}
