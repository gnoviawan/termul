//! Frames the main frame's helpers cannot enter. Same-origin frames and
//! open shadow roots need nothing here: the helpers walk into them and
//! their paths cross the boundary. A cross-origin frame shows in the main
//! outline as a frame item; where the engine reaches the frame on its own,
//! the host runs the snapshot helper there, splices its outline in, and
//! routes every helper for a ref minted from it to that frame.
//!
//! A cross-origin frame's origin goes through the same origin
//! authorization as a navigation: its outline is spliced in only when the
//! session may reach that origin, and a ref minted in it acts only after
//! the frame's current origin is authorized again.

use serde::Deserialize;
use serde_json::Value;
use tauri::Url;

use super::authz::HopVerdict;
use super::consent::OriginRequest;
use super::events::label_prefix;
use super::ports::TabProfile;
use super::reply::{engine_error, parse_snapshot, PageSnapshot, SnapshotItem, ERR_CAPABILITY};
use super::tabs::RefNode;
use super::stop::StopToken;
use super::{BrowserError, DesktopBrowserHost};
use crate::browser_automation::budgets::Deadline;
use crate::browser_automation::BrowserCall;
use crate::browser_automation::engine::assets::{self, Script};
use crate::browser_automation::engine::{ChildFrame, EngineError, Point};

/// Frames nested in frames the host follows; deeper ones stay unreachable.
const MAX_FRAME_DEPTH: usize = 4;
/// Outline items across the page and every spliced frame.
const MAX_ITEMS: usize = 1600;

/// What is left of the outline's item cap while frames are spliced.
struct Room {
    left: usize,
    capped: bool,
    /// Some frame's helper cut page text to its limit.
    cut: bool,
}

#[derive(Deserialize)]
struct Origin {
    x: f64,
    y: f64,
}

impl DesktopBrowserHost {
    pub(super) async fn eval_frame(&self, label: &str, frame: Option<&str>, script: Script) -> Result<Value, BrowserError> {
        let Some(frame) = frame else {
            return self.eval(label, script).await;
        };
        self.engine.evaluate_in_frame(label, frame, script).await.map_err(|e: EngineError| {
            log::warn!("[browser-agent] frame eval failed on tab {} ({:?})", label_prefix(label), e.kind);
            engine_error(e, label)
        })
    }

    /// Run a helper for `node`'s element in the frame its ref was minted in.
    pub(super) async fn eval_ref(&self, label: &str, node: &RefNode, script: Script) -> Result<Value, BrowserError> {
        let frame = (!node.frame.is_empty()).then_some(node.frame.as_str());
        self.eval_frame(label, frame, script).await
    }

    /// The page outline with every reachable cross-origin frame the
    /// session may read spliced in.
    pub(super) async fn snapshot_page(&self, session_id: &str, label: &str) -> Result<PageSnapshot, BrowserError> {
        let mut page = parse_snapshot(self.eval(label, assets::snapshot()).await?)?;
        if !page.items.iter().any(|i| matches!(i, SnapshotItem::Frame { .. })) {
            return Ok(page);
        }
        // Without frame access the frames stay in the outline, unreachable.
        let frames = self.engine.child_frames(label).await.unwrap_or_default();
        let mut room = Room {
            left: MAX_ITEMS.saturating_sub(page.items.len()),
            capped: page.capped,
            cut: page.cut,
        };
        let items = std::mem::take(&mut page.items);
        page.items = self.splice(session_id, label, &frames, None, items, 0, &mut room).await;
        page.capped = room.capped;
        page.cut = room.cut;
        Ok(page)
    }

    /// Replace each frame item of `parent`'s outline with the frame's own
    /// outline, one level deeper, when the engine reaches the frame.
    #[allow(clippy::too_many_arguments, reason = "one recursion step over the frame tree")]
    async fn splice(
        &self,
        session_id: &str,
        label: &str,
        frames: &[ChildFrame],
        parent: Option<&str>,
        items: Vec<SnapshotItem>,
        nesting: usize,
        room: &mut Room,
    ) -> Vec<SnapshotItem> {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let SnapshotItem::Frame { depth, name, path, .. } = &item else {
                out.push(item);
                continue;
            };
            let child = frames
                .iter()
                .find(|f| f.parent.as_deref() == parent && f.owner_path == *path)
                .filter(|_| nesting < MAX_FRAME_DEPTH);
            let inner = match child {
                Some(child) => self.frame_outline(label, child).await,
                None => None,
            };
            let (Some(child), Some(inner)) = (child, inner) else {
                out.push(item);
                continue;
            };
            if let Err(origin) = self.frame_readable(session_id, &inner.url) {
                out.push(SnapshotItem::Frame {
                    depth: *depth,
                    name: name.clone(),
                    path: path.clone(),
                    unauthorized: Some(origin),
                });
                continue;
            }
            let mut inner_items = inner.items;
            let found = inner_items.len();
            inner_items.truncate(room.left);
            room.capped |= inner.capped || inner_items.len() < found;
            room.cut |= inner.cut;
            room.left -= inner_items.len();
            for nested in &mut inner_items {
                *nested.depth_mut() += depth + 1;
                if let SnapshotItem::Node { frame, .. } = nested {
                    frame.clone_from(&child.id);
                }
            }
            out.push(SnapshotItem::Landmark {
                depth: *depth,
                role: "iframe".to_string(),
                name: name.clone(),
            });
            let spliced = Box::pin(self.splice(session_id, label, frames, Some(&child.id), inner_items, nesting + 1, room));
            out.extend(spliced.await);
        }
        out
    }

    /// Whether the session may read a frame showing `url`: the hop
    /// verdict alone, so reading never prompts. The URL comes from the
    /// evaluation that read the outline, so it names the document read.
    /// `Err` carries the origin to show in the frame's place.
    fn frame_readable(&self, session_id: &str, url: &str) -> Result<(), String> {
        let Ok(url) = url.parse::<Url>() else {
            return Err("an unknown origin".to_string());
        };
        match self.gate.check_hop(session_id, &url) {
            HopVerdict::Allow => Ok(()),
            _ if url.origin().is_tuple() => Err(url.origin().ascii_serialization()),
            _ => Err("an opaque origin".to_string()),
        }
    }

    /// Authorize the current origin of every cross-origin frame the call's
    /// refs were minted in, as a navigation there would be: a denied origin
    /// is refused, an ungranted one asks the user.
    pub(super) async fn authorize_frames(
        &self,
        token: &StopToken,
        session_id: &str,
        call: &BrowserCall,
        project_id: &str,
        profile: TabProfile,
        deadline: Deadline,
    ) -> Result<(), BrowserError> {
        let Ok(label) = self.resolve_tab(session_id, &call.args) else {
            return Ok(());
        };
        for key in ["ref", "toRef"] {
            let Some(text) = call.args.get(key).and_then(Value::as_str) else {
                continue;
            };
            // A ref that no longer resolves is reported by the verb itself.
            let Ok(resolved) = self.resolve_ref(&label, text) else {
                continue;
            };
            if resolved.node.frame.is_empty() {
                continue;
            }
            let out = self.eval_ref(&label, &resolved.node, assets::location()).await?;
            let url = out.as_str().unwrap_or_default();
            let request = OriginRequest {
                session_id,
                project_id,
                url,
                element: call.element.as_deref(),
                profile,
                deadline,
            };
            self.gate.authorize(token, request).await?;
        }
        Ok(())
    }

    /// Authorize the origin of the cross-origin frame that holds focus,
    /// for a key or text sent to whatever has focus: the input lands in
    /// that frame, as an action through a ref minted there would. A focused
    /// frame the engine cannot reach has no origin to check, so the call is
    /// refused.
    pub(super) async fn authorize_focused_frame(
        &self,
        token: &StopToken,
        session_id: &str,
        call: &BrowserCall,
        project_id: &str,
        profile: TabProfile,
        deadline: Deadline,
    ) -> Result<(), BrowserError> {
        let Ok(label) = self.resolve_tab(session_id, &call.args) else {
            return Ok(());
        };
        let Some(mut path) = self.eval(&label, assets::focused_frame()).await?.as_str().map(str::to_string) else {
            return Ok(());
        };
        let unreachable = || {
            BrowserError::new(ERR_CAPABILITY, "focus is in a cross-origin frame this engine cannot reach; pass a ref")
                .with_reason("focused_frame_unreachable")
        };
        let frames = self.engine.child_frames(&label).await.unwrap_or_default();
        let mut parent: Option<String> = None;
        for _ in 0..=MAX_FRAME_DEPTH {
            let child = frames
                .iter()
                .find(|f| f.parent == parent && f.owner_path == path)
                .ok_or_else(unreachable)?;
            let inner = self.eval_frame(&label, Some(&child.id), assets::focused_frame()).await?;
            if let Some(next) = inner.as_str() {
                path = next.to_string();
                parent = Some(child.id.clone());
                continue;
            }
            let out = self.eval_frame(&label, Some(&child.id), assets::location()).await?;
            let request = OriginRequest {
                session_id,
                project_id,
                url: out.as_str().unwrap_or_default(),
                element: call.element.as_deref(),
                profile,
                deadline,
            };
            return self.gate.authorize(token, request).await;
        }
        Err(unreachable())
    }

    async fn frame_outline(&self, label: &str, frame: &ChildFrame) -> Option<PageSnapshot> {
        let out = self.eval_frame(label, Some(&frame.id), assets::frame_snapshot()).await.ok()?;
        parse_snapshot(out).ok()
    }

    /// Where `frame`'s viewport starts in main-frame CSS px: its frame
    /// element's content box in its parent, summed up to the page.
    pub(super) async fn frame_origin(&self, label: &str, frame: &str) -> Result<Point, BrowserError> {
        let gone = || {
            BrowserError::new(super::ERR_STALE_REF, "the frame holding the element is gone; take a new snapshot")
                .with_reason("frame_gone")
        };
        let frames = self.engine.child_frames(label).await.map_err(|e| engine_error(e, label))?;
        let mut at = Point { x: 0.0, y: 0.0 };
        let mut current = frame;
        for _ in 0..=MAX_FRAME_DEPTH {
            let child = frames.iter().find(|f| f.id == current).ok_or_else(gone)?;
            let out = self
                .eval_frame(label, child.parent.as_deref(), assets::frame_origin(&child.owner_path))
                .await?;
            let origin: Origin = serde_json::from_value(out).map_err(|_| gone())?;
            at.x += origin.x;
            at.y += origin.y;
            match &child.parent {
                None => return Ok(at),
                Some(parent) => current = parent,
            }
        }
        Err(gone())
    }
}

#[cfg(test)]
#[path = "frames_tests.rs"]
pub(super) mod tests;
