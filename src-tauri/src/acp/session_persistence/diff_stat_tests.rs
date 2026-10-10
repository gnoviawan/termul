use super::diff_stat::*;
use serde_json::json;

fn counts(added: u64, removed: u64) -> LineCounts {
    LineCounts { added, removed }
}

#[test]
fn split_lines_matches_renderer_rules() {
    assert!(split_lines("").is_empty());
    assert_eq!(split_lines("a"), vec!["a"]);
    // The trailing empty segment after a final newline is dropped (once).
    assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
    assert_eq!(split_lines("a\n\n"), vec!["a", ""]);
    assert_eq!(split_lines("\n"), vec![""]);
    // One trailing CR per line is trimmed (CRLF content).
    assert_eq!(split_lines("a\r\nb\r\r\n"), vec!["a", "b\r"]);
}

#[test]
fn new_and_deleted_files_count_every_line() {
    // oldText null / "" → all added.
    assert_eq!(diff_line_counts(None, "a\nb\nc\n"), counts(3, 0));
    assert_eq!(diff_line_counts(Some(""), "a\nb"), counts(2, 0));
    // Both empty: nothing changed (the new-file rule wins).
    assert_eq!(diff_line_counts(Some(""), ""), counts(0, 0));
    // newText "" → all removed.
    assert_eq!(diff_line_counts(Some("a\nb\n"), ""), counts(0, 2));
}

#[test]
fn edits_count_n_minus_lcs_after_edge_trim() {
    // Identical text: no change.
    assert_eq!(diff_line_counts(Some("a\nb\n"), "a\nb\n"), counts(0, 0));
    // One replaced line, one appended line.
    assert_eq!(
        diff_line_counts(Some("a\nb\nc\n"), "a\nB\nc\nd\n"),
        counts(2, 1)
    );
    // Pure insertion in the middle (one side empty after trimming).
    assert_eq!(diff_line_counts(Some("a\nc\n"), "a\nb\nc\n"), counts(1, 0));
    // Reordered lines: LCS("abcd", "badc") = 2.
    assert_eq!(
        diff_line_counts(Some("a\nb\nc\nd"), "b\na\nd\nc"),
        counts(2, 2)
    );
    // CRLF vs LF of the same lines is not a change.
    assert_eq!(diff_line_counts(Some("a\r\nb\r\n"), "a\nb\n"), counts(0, 0));
}

#[test]
fn exact_lcs_holds_at_the_cell_bound() {
    // 1000 × 2000 = 2,000,000 cells — still exact. Old: 0..1000, new: the
    // same lines reversed plus 1000 fresh lines → LCS 1.
    let old: Vec<String> = (0..1000).map(|i| format!("l{i}")).collect();
    let mut new: Vec<String> = old.iter().rev().cloned().collect();
    new.extend((0..1000).map(|i| format!("n{i}")));
    let result = diff_line_counts(Some(old.join("\n").as_str()), &new.join("\n"));
    assert_eq!(result, counts(1999, 999));
}

#[test]
fn above_the_bound_uses_the_multiset_approximation() {
    // 1500 × 1500 = 2,250,000 cells > bound. Reversed lines (with the
    // first one replaced) share 1499 values: the multiset intersection
    // stands in for the exact LCS (1), so the approximation reports +1 −1
    // where the exact diff would say +1499 −1499 — it never inflates counts.
    let old: Vec<String> = (0..1500).map(|i| format!("l{i}")).collect();
    let mut new: Vec<String> = old.iter().rev().cloned().collect();
    new[0] = "changed".to_string();
    let result = diff_line_counts(Some(old.join("\n").as_str()), &new.join("\n"));
    assert_eq!(result, counts(1, 1));
}

#[test]
fn content_diff_stat_sums_diff_items_only() {
    let content = json!([
        {"type": "content", "content": {"type": "text", "text": "x\ny\n"}},
        {"type": "diff", "path": "/a.ts", "oldText": "1\n2\n", "newText": "1\n3\n"},
        {"type": "diff", "path": "/b.ts", "oldText": null, "newText": "n\n"},
        // Absent newText defaults to "" → a deletion.
        {"type": "diff", "path": "/c.ts", "oldText": "gone\n"},
    ]);
    assert_eq!(content_diff_stat(Some(&content)), Some(counts(2, 2)));
    // No diff item / not an array / absent → no stat.
    assert_eq!(content_diff_stat(Some(&json!([{"type": "content"}]))), None);
    assert_eq!(content_diff_stat(Some(&json!({"type": "diff"}))), None);
    assert_eq!(content_diff_stat(None), None);
    // A diff item with no text at all still yields a (zero) stat.
    assert_eq!(
        content_diff_stat(Some(&json!([{"type": "diff", "path": "/d.ts"}]))),
        Some(counts(0, 0))
    );
}
