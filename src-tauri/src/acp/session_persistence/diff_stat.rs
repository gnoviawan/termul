//! Host-side `+N −N` line counts for durable file-change summaries.
//!
//! The durable tool DTO never persists diff text, so the line counts the
//! renderer's Changed files panel shows for a restored session must be
//! computed here, at normalize time, from the live event's diff items. This
//! mirrors the renderer's `diffLineCounts` (`tool-call-format.ts`); within
//! the exact-LCS bound below, a restored row shows the same counts the live
//! card showed:
//!
//! - Same `splitLines` rules: empty text → no lines; the trailing empty
//!   segment after a final `\n` is dropped; one trailing `\r` per line is
//!   trimmed (CRLF content).
//! - `oldText` null/absent/`""` → every new line is an addition (new file).
//! - `newText` `""` (or absent — the renderer defaults it to `""`) → every
//!   old line is a removal (deleted file).
//! - Otherwise `added = n − LCS`, `removed = m − LCS`, where the LCS is
//!   computed exactly after trimming the common prefix/suffix, as long as the
//!   trimmed middle fits [`MAX_LCS_CELLS`] (the renderer's exact-diff bound).
//!
//! Above the bound there is NO parity. The renderer switches to an
//! anchor-chained heuristic; the host instead uses a **multiset
//! approximation**: the common-line count of the trimmed middle is the size
//! of the multiset intersection of its lines (each line value matched at
//! most as many times as it occurs on both sides). That is an upper bound on
//! the true LCS, so it never inflates counts but can under-report them
//! heavily on large reordered rewrites — e.g. a reversed 1500-line file with
//! one line replaced restores as `+1 −1` where the renderer shows roughly
//! `+1499 −1499`. It is linear in the input.

use std::collections::HashMap;

use serde_json::Value;

/// Max (trimmed) cells for the exact LCS — parity with the renderer's
/// `MAX_LCS_CELLS`.
pub(crate) const MAX_LCS_CELLS: usize = 2_000_000;

/// Added/removed line counts for one or more diff items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct LineCounts {
    pub added: u64,
    pub removed: u64,
}

/// Renderer `splitLines` parity.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut parts: Vec<&str> = text.split('\n').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// Renderer `diffLineCounts` parity for one diff item (`oldText` may be
/// absent/null; an absent `newText` is passed as `""`).
pub(crate) fn diff_line_counts(old_text: Option<&str>, new_text: &str) -> LineCounts {
    let new_lines = split_lines(new_text);
    let Some(old_text) = old_text.filter(|text| !text.is_empty()) else {
        // New file: all lines are additions.
        return LineCounts {
            added: new_lines.len() as u64,
            removed: 0,
        };
    };
    let old_lines = split_lines(old_text);
    if new_text.is_empty() {
        // Deleted file: all lines are removals.
        return LineCounts {
            added: 0,
            removed: old_lines.len() as u64,
        };
    }
    let common = common_line_count(&old_lines, &new_lines);
    LineCounts {
        added: (new_lines.len() - common) as u64,
        removed: (old_lines.len() - common) as u64,
    }
}

/// Sum of [`diff_line_counts`] over every `type: "diff"` item in an ACP
/// tool `content` array (renderer `diffInfo` parity). `None` when the value
/// is not an array or holds no diff item — the event carries no diff stat.
pub(crate) fn content_diff_stat(content: Option<&Value>) -> Option<LineCounts> {
    let items = content?.as_array()?;
    let mut total: Option<LineCounts> = None;
    for item in items.iter().filter(|item| is_diff_item(item)) {
        let counts = diff_line_counts(
            item.get("oldText").and_then(Value::as_str),
            item.get("newText").and_then(Value::as_str).unwrap_or(""),
        );
        let sum = total.get_or_insert_with(LineCounts::default);
        sum.added = sum.added.saturating_add(counts.added);
        sum.removed = sum.removed.saturating_add(counts.removed);
    }
    total
}

/// True for an ACP `{"type": "diff", …}` content item.
pub(crate) fn is_diff_item(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("diff")
}

/// Count of lines common to both sides: shared prefix + shared suffix + the
/// (exact or approximated) LCS of the trimmed middle.
fn common_line_count(old: &[&str], new: &[&str]) -> usize {
    let head = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let (old_rest, new_rest) = (&old[head..], &new[head..]);
    let tail = old_rest
        .iter()
        .rev()
        .zip(new_rest.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_mid = &old_rest[..old_rest.len() - tail];
    let new_mid = &new_rest[..new_rest.len() - tail];
    if old_mid.is_empty() || new_mid.is_empty() {
        return head + tail;
    }
    let middle = if old_mid.len().saturating_mul(new_mid.len()) <= MAX_LCS_CELLS {
        lcs_len(old_mid, new_mid)
    } else {
        multiset_common(old_mid, new_mid)
    };
    head + tail + middle
}

/// Exact LCS length with a single rolling row over the shorter side
/// (O(m·n) time, O(min(m, n)) memory).
fn lcs_len(a: &[&str], b: &[&str]) -> usize {
    let (outer, inner) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    let mut row = vec![0usize; inner.len() + 1];
    for outer_line in outer {
        let mut diagonal = 0usize;
        for (j, inner_line) in inner.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if outer_line == inner_line {
                diagonal + 1
            } else {
                above.max(row[j])
            };
            diagonal = above;
        }
    }
    row[inner.len()]
}

/// Above-bound approximation: size of the multiset intersection of the two
/// line sequences (an upper bound on the LCS; see the module docs).
fn multiset_common(a: &[&str], b: &[&str]) -> usize {
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for line in a {
        *remaining.entry(*line).or_insert(0) += 1;
    }
    let mut common = 0;
    for line in b {
        if let Some(count) = remaining.get_mut(line) {
            if *count > 0 {
                *count -= 1;
                common += 1;
            }
        }
    }
    common
}
