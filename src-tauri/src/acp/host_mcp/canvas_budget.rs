//! How long the gateway waits for one canvas call (AD-29).
//!
//! Most calls get `canvas.call_timeout_ms`. A call that renders pixels (a
//! raster `file.export`, or the `host.renderPng` behind `screenshot`) costs
//! time in proportion to the pixels it writes, and effects such as shadows
//! and blurs cost most, so it gets the call timeout plus a share per output
//! megapixel, up to [`MAX_RENDER_BUDGET`]. The output size is the union of
//! the target layers' bounds times the scale; the bounds come from the
//! editor through lookups that never count toward the crash timeouts. When
//! they cannot be read (the editor is busy, or too many layers are named)
//! the call gets the whole [`MAX_RENDER_BUDGET`].

use std::time::Duration;

use serde_json::{json, Value};

use crate::acp::host_mcp::presence::Bounds;
use crate::canvas::persistence::CanvasPersistence;

/// Time allowed per output megapixel on top of the call timeout. A
/// drop-shadowed layer exports at about 0.4 s per megapixel in the native
/// engine and 0.65 s in the wasm editor (#1427), so this leaves room for
/// layers with several effects.
pub const PER_MEGAPIXEL: Duration = Duration::from_millis(2_000);
/// The longest any render waits, however large.
pub const MAX_RENDER_BUDGET: Duration = Duration::from_secs(180);
/// figcraft's largest export scale (`ExportSize::MAX_SCALE`); a larger one
/// renders at this.
const MAX_SCALE: f64 = 64.0;
/// Bounds lookups one estimate makes before it gives up and allows the most.
const MAX_LOOKUPS: usize = 16;
/// A bounds lookup that takes longer is dropped.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);

/// A call that renders pixels: which layers, and how they are sized.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderCall {
    pub targets: Targets,
    pub size: OutputSize,
}

/// The layers a render draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Targets {
    Ids(Vec<u64>),
    /// `file.export` without ids: the selection, else the page's layers.
    SelectionOrPage,
    /// `host.renderPng` without ids: the page's layers.
    Page,
}

/// How a render sizes its layers' bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputSize {
    Scale(f64),
    Width(f64),
    Height(f64),
}

/// The render `method` with `params` asks for, or `None` for a call that
/// renders no pixels (vector and `fig` exports included).
#[must_use]
pub fn render_call(method: &str, params: &Value) -> Option<RenderCall> {
    let params = match method {
        "host.renderPng" => params,
        "engine.execute"
            if params.get("command").and_then(Value::as_str) == Some("file.export") =>
        {
            let params = params.get("params").unwrap_or(&Value::Null);
            let format = params.get("format").and_then(Value::as_str);
            let raster = format.is_none_or(|format| {
                matches!(
                    format.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp"
                )
            });
            if !raster {
                return None;
            }
            params
        }
        _ => return None,
    };
    let ids: Vec<u64> = params
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default();
    let targets = match (ids.is_empty(), method) {
        (false, _) => Targets::Ids(ids),
        (true, "host.renderPng") => Targets::Page,
        (true, _) => Targets::SelectionOrPage,
    };
    let size = params.get("size").and_then(size_param).unwrap_or_else(|| {
        OutputSize::Scale(params.get("scale").and_then(Value::as_f64).unwrap_or(1.0))
    });
    Some(RenderCall { targets, size })
}

/// figcraft's `size`: `2x`, `@2x`, `2`, `512w` or `512h`, or a bare number.
fn size_param(size: &Value) -> Option<OutputSize> {
    if let Some(scale) = size.as_f64() {
        return Some(OutputSize::Scale(scale));
    }
    let text = size
        .as_str()?
        .trim()
        .trim_start_matches('@')
        .to_ascii_lowercase();
    let (number, unit) = match text.char_indices().last() {
        Some((at, unit)) if unit.is_ascii_alphabetic() => (text.get(..at)?.trim(), Some(unit)),
        _ => (text.as_str(), None),
    };
    let value: f64 = number.parse().ok()?;
    match unit {
        None | Some('x') => Some(OutputSize::Scale(value)),
        Some('w') => Some(OutputSize::Width(value)),
        Some('h') => Some(OutputSize::Height(value)),
        Some(_) => None,
    }
}

/// The pixels a `width` × `height` box renders to at `size`, with the
/// scale clamped as figcraft clamps it.
#[must_use]
pub fn output_pixels(size: OutputSize, width: f64, height: f64) -> f64 {
    let scale = match size {
        OutputSize::Scale(scale) => scale,
        OutputSize::Width(pixels) if width > 0.0 => pixels / width,
        OutputSize::Height(pixels) if height > 0.0 => pixels / height,
        OutputSize::Width(_) | OutputSize::Height(_) => 1.0,
    };
    let scale = if scale.is_finite() && scale > 0.0 {
        scale.min(MAX_SCALE)
    } else {
        1.0
    };
    (width * scale).max(1.0) * (height * scale).max(1.0)
}

/// The wait for a render of `pixels` (`None`: unknown) when ordinary calls
/// wait `call_timeout`.
#[must_use]
pub fn render_budget(call_timeout: Duration, pixels: Option<f64>) -> Duration {
    let ceiling = MAX_RENDER_BUDGET.max(call_timeout);
    let Some(pixels) = pixels.filter(|pixels| pixels.is_finite()) else {
        return ceiling;
    };
    let extra = PER_MEGAPIXEL.as_secs_f64() * pixels.max(0.0) / 1_000_000.0;
    (call_timeout + Duration::from_secs_f64(extra.min(ceiling.as_secs_f64()))).min(ceiling)
}

/// The wait for `method` with `params` on `project_id`'s canvas: the call
/// timeout, or a render's budget from its layers' bounds.
pub async fn call_budget(
    mounts: &CanvasPersistence,
    project_id: &str,
    method: &str,
    params: Option<&Value>,
    call_timeout: Duration,
) -> Duration {
    let Some(render) = params.and_then(|params| render_call(method, params)) else {
        return call_timeout;
    };
    let pixels = target_bounds(mounts, project_id, &render.targets)
        .await
        .map(|(width, height)| output_pixels(render.size, width, height));
    let budget = render_budget(call_timeout, pixels);
    log::debug!(
        "[canvas-gateway] {method} for project {project_id} renders {} px: waits {} ms",
        pixels.map_or_else(|| "unknown".to_string(), |pixels| format!("{pixels:.0}")),
        budget.as_millis()
    );
    budget
}

/// The width and height of the union of `targets`' bounds.
async fn target_bounds(
    mounts: &CanvasPersistence,
    project_id: &str,
    targets: &Targets,
) -> Option<(f64, f64)> {
    let lookup = |method: &'static str, params: Value| async move {
        let result = mounts
            .presence_call(project_id, method, params.to_string(), LOOKUP_TIMEOUT)
            .await
            .ok()?;
        serde_json::from_str::<Value>(&result).ok()
    };
    let ids = match targets {
        Targets::Ids(ids) => ids.clone(),
        Targets::SelectionOrPage => {
            let document = lookup("document.inspect", json!({ "depth": 0 })).await?;
            selection_of(&document)
        }
        Targets::Page => Vec::new(),
    };
    if ids.is_empty() {
        let document = lookup("document.inspect", json!({ "depth": 1 })).await?;
        return union(&page_layer_bounds(&document)?);
    }
    if ids.len() > MAX_LOOKUPS {
        return None;
    }
    let mut bounds = Vec::with_capacity(ids.len());
    for id in ids {
        let node = lookup("node.get", json!({ "id": id, "depth": 0 })).await?;
        bounds.push(Bounds::of_node(&node)?);
    }
    union(&bounds)
}

fn selection_of(document: &Value) -> Vec<u64> {
    document
        .get("selection")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default()
}

/// The bounds of the current page's top-level layers in a `document.inspect`
/// result; `None` when one has none.
fn page_layer_bounds(document: &Value) -> Option<Vec<Bounds>> {
    let current = document.get("currentPage");
    let pages = document.get("pages")?.as_array()?;
    let page = pages
        .iter()
        .find(|page| page.get("id") == current)
        .or_else(|| pages.first())?;
    page.get("children")?
        .as_array()?
        .iter()
        .map(Bounds::of_node)
        .collect()
}

fn union(bounds: &[Bounds]) -> Option<(f64, f64)> {
    let first = bounds.first()?;
    let (mut x0, mut y0) = (first.x, first.y);
    let (mut x1, mut y1) = (first.x + first.width, first.y + first.height);
    for bound in &bounds[1..] {
        x0 = x0.min(bound.x);
        y0 = y0.min(bound.y);
        x1 = x1.max(bound.x + bound.width);
        y1 = y1.max(bound.y + bound.height);
    }
    Some((x1 - x0, y1 - y0))
}

#[cfg(test)]
mod tests;
