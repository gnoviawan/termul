//! The mount cap (spine AD-26): at most `canvas.max_mounted` canvases are
//! mounted, and admitting one more evicts the least recently active.
//!
//! Activity is a user looking at the canvas ([`CanvasPersistence::set_visible`])
//! or an agent calling it, so a hidden project an agent is working in is not
//! the victim. An eviction is an ordinary [`CanvasPersistence::close`]: the
//! AD-31 sequence saves first, and a victim that cannot be saved stays
//! mounted while the next least active one is tried; only when none can be
//! saved is the new mount blocked.
//!
//! The cap is the host's: each mount remembers the `canvas.max_mounted` it
//! was opened under, and the highest of those and the opener's applies, so a
//! renderer with a lower setting cannot unload canvases another renderer
//! opened under a higher one.

use serde::Serialize;

use std::sync::Arc;

use super::{CanvasPersistence, Lifecycle, Mount, Opened};
use crate::acp::host_mcp::canvas::LeaseLostReason;
use crate::canvas::CanvasError;

/// `canvas.max_mounted` when the renderer sends none.
pub const DEFAULT_MAX_MOUNTED: usize = 2;
const MAX_MAX_MOUNTED: usize = 16;

/// A canvas could not be unloaded to make room, so the new mount was refused.
pub const CODE_EVICTION_BLOCKED: &str = "EVICTION_BLOCKED";

const REASON_CAP_REACHED: &str = "mount cap reached";

/// The cap for a requested `canvas.max_mounted`, clamped to a sane range.
pub fn mount_cap(requested: Option<u64>) -> usize {
    requested.map_or(DEFAULT_MAX_MOUNTED, |cap| {
        usize::try_from(cap).map_or(MAX_MAX_MOUNTED, |cap| cap.clamp(1, MAX_MAX_MOUNTED))
    })
}

/// A canvas the cap unmounted after saving it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Eviction {
    pub project_id: String,
    pub reason: &'static str,
}

/// What [`CanvasPersistence::open`] did. `evicted` lists every canvas
/// unmounted along the way, including when `opened` is the refusal:
/// evictions that finished before a later victim failed to save are not
/// undone.
#[derive(Debug)]
pub struct Admitted {
    pub evicted: Vec<Eviction>,
    pub opened: Result<Opened, CanvasError>,
}

fn blocked(message: String) -> CanvasError {
    CanvasError::new(CODE_EVICTION_BLOCKED, message)
}

impl CanvasPersistence {
    /// The cap an open asking for `requested` works under: the highest of it
    /// and the caps every live mount was opened under.
    pub(super) fn host_cap(&self, requested: usize) -> usize {
        self.mounts
            .lock()
            .values()
            .map(|mount| mount.max_mounted)
            .fold(requested, usize::max)
    }

    /// Unmount the least recently active other canvases until fewer than
    /// `cap` remain. The project's own mount is replaced by the open, not
    /// counted. Call with the admission lock held, so two opens cannot both
    /// see room.
    ///
    /// A victim that cannot be saved stays mounted and the next least active
    /// one is tried. When no candidate is left (each could not be saved or
    /// is already closing), the open is `EVICTION_BLOCKED`.
    pub(super) async fn make_room(
        &self,
        project_id: &str,
        cap: usize,
        evicted: &mut Vec<Eviction>,
    ) -> Result<(), CanvasError> {
        let mut unsaveable: Vec<(String, String)> = Vec::new();
        while let Some(candidates) = self.victims(project_id, cap) {
            let Some((victim, mount)) = candidates
                .into_iter()
                .find(|(project, _)| unsaveable.iter().all(|(skipped, _)| skipped != project))
            else {
                return Err(blocked_by(&unsaveable));
            };
            match self
                .save_and_unmount(&victim, &mount, LeaseLostReason::Evicted)
                .await
            {
                Ok(outcome) if outcome.unmounted => evicted.push(Eviction {
                    project_id: victim,
                    reason: REASON_CAP_REACHED,
                }),
                Ok(_) => {}
                Err(error) => unsaveable.push((victim, error.message)),
            }
        }
        Ok(())
    }

    /// The open mounts that could be unloaded so one more canvas fits under
    /// `cap`, least recently active first; `None` when there is room.
    fn victims(&self, project_id: &str, cap: usize) -> Option<Vec<(String, Arc<Mount>)>> {
        let others: Vec<_> = self
            .mounts
            .lock()
            .iter()
            .filter(|(project, _)| project.as_str() != project_id)
            .map(|(project, mount)| (project.clone(), mount.clone()))
            .collect();
        if others.len() < cap {
            return None;
        }
        let mut open: Vec<_> = others
            .into_iter()
            .filter_map(|(project, mount)| {
                let rank = {
                    let state = mount.state.lock();
                    (state.lifecycle == Lifecycle::Open).then(|| state.activity.rank())
                };
                rank.map(|rank| (rank, project, mount))
            })
            .collect();
        open.sort_by_key(|(rank, _, _)| *rank);
        Some(
            open.into_iter()
                .map(|(_, project, mount)| (project, mount))
                .collect(),
        )
    }
}

/// No canvas could make room: each candidate failed to save (`unsaveable`,
/// with why) or every other one is already closing.
fn blocked_by(unsaveable: &[(String, String)]) -> CanvasError {
    if unsaveable.is_empty() {
        return blocked("every other canvas is closing; try again".to_string());
    }
    let reasons: Vec<String> = unsaveable
        .iter()
        .map(|(project, why)| format!("project {project}: {why}"))
        .collect();
    blocked(format!(
        "could not unload a canvas to make room ({})",
        reasons.join("; ")
    ))
}
