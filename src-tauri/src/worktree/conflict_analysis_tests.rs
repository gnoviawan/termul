use super::*;

#[test]
fn test_is_whitespace_only_conflict() {
    // Identical non-whitespace content, different whitespace
    assert!(WorktreeManager::is_whitespace_only_conflict(
        "const x = 1;",
        "const  x  =  1;"
    ));

    assert!(WorktreeManager::is_whitespace_only_conflict(
        "function test() {\n  return true;\n}",
        "function test(){return true;}"
    ));

    // Different content should return false
    assert!(!WorktreeManager::is_whitespace_only_conflict(
        "const x = 1;",
        "const y = 1;"
    ));

    // Empty strings should return false
    assert!(!WorktreeManager::is_whitespace_only_conflict("", ""));
}

#[test]
fn test_are_changes_identical() {
    // Identical with trimming
    assert!(WorktreeManager::are_changes_identical(
        "  const x = 1;  ",
        "const x = 1;"
    ));

    // Different content
    assert!(!WorktreeManager::are_changes_identical(
        "const x = 1;",
        "const y = 2;"
    ));

    // Empty should return false
    assert!(!WorktreeManager::are_changes_identical("", ""));
}

#[test]
fn test_is_import_reorder_conflict() {
    // Same imports, different order
    let ours = "import React from 'react'\nimport { useState } from 'react'";
    let theirs = "import { useState } from 'react'\nimport React from 'react'";
    assert!(WorktreeManager::is_import_reorder_conflict(ours, theirs));

    // Different imports
    let ours = "import React from 'react'";
    let theirs = "import Vue from 'vue'";
    assert!(!WorktreeManager::is_import_reorder_conflict(ours, theirs));

    // No imports
    let ours = "const x = 1;";
    let theirs = "const y = 2;";
    assert!(!WorktreeManager::is_import_reorder_conflict(ours, theirs));
}

#[test]
fn test_is_trivial_formatting() {
    // Single vs double quotes
    assert!(WorktreeManager::is_trivial_formatting(
        "const x = \"hello\";",
        "const x = 'hello';"
    ));

    // With/without semicolons
    assert!(WorktreeManager::is_trivial_formatting(
        "const x = 1;",
        "const x = 1"
    ));

    // Trailing comma
    assert!(WorktreeManager::is_trivial_formatting(
        "const arr = [1, 2, 3,]",
        "const arr = [1, 2, 3]"
    ));

    // Different content
    assert!(!WorktreeManager::is_trivial_formatting(
        "const x = 1;",
        "const y = 2;"
    ));
}

#[test]
fn test_extract_conflict_blocks() {
    let content = r#"
normal code
<<<<<<< HEAD
ours version
=======
theirs version
>>>>>>> branch
more normal code
"#;
    let blocks = WorktreeManager::extract_conflict_blocks(content);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].ours.trim(), "ours version");
    assert_eq!(blocks[0].theirs.trim(), "theirs version");
    assert_eq!(blocks[0].base, "");
}

#[test]
fn test_extract_conflict_blocks_with_base() {
    let content = r#"
<<<<<<< HEAD
ours version
||||||| base
base version
=======
theirs version
>>>>>>> branch
"#;
    let blocks = WorktreeManager::extract_conflict_blocks(content);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].ours.trim(), "ours version");
    assert_eq!(blocks[0].theirs.trim(), "theirs version");
    assert_eq!(blocks[0].base.trim(), "base version");
}

#[test]
fn test_extract_multiple_conflict_blocks() {
    let content = r#"
<<<<<<< HEAD
first ours
=======
first theirs
>>>>>>> branch
normal code
<<<<<<< HEAD
second ours
=======
second theirs
>>>>>>> branch
"#;
    let blocks = WorktreeManager::extract_conflict_blocks(content);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].ours.trim(), "first ours");
    assert_eq!(blocks[1].ours.trim(), "second ours");
}

#[test]
fn test_analyze_lockfile_conflict() {
    let suggestions =
        WorktreeManager::analyze_conflict_and_suggest("/test/worktree", "package-lock.json", true);

    assert!(!suggestions.is_empty());
    assert!(suggestions.iter().any(|s| s.strategy == "accept-theirs"));
    assert!(suggestions.iter().any(|s| s.strategy == "regenerate"));
    assert!(suggestions.iter().any(|s| s.confidence == "high"));
}

#[test]
fn test_extract_lines_splits_cr_lf_and_crlf() {
    // Mirrors real `git worktree add` stderr: \r-delimited progress updates
    // interleaved with \n lines and a CRLF pair.
    let mut buf =
        b"Preparing worktree\nUpdating files:  10%\rUpdating files:  20%\rHEAD is now at abc\r\n"
            .to_vec();
    let lines = extract_lines(&mut buf);
    assert_eq!(
        lines,
        vec![
            "Preparing worktree",
            "Updating files:  10%",
            "Updating files:  20%",
            "HEAD is now at abc"
        ]
    );
    assert!(buf.is_empty());
}

#[test]
fn test_extract_lines_keeps_partial_tail() {
    let mut buf = b"Updating files:  10%\rpartial".to_vec();
    let lines = extract_lines(&mut buf);
    assert_eq!(lines, vec!["Updating files:  10%"]);
    assert_eq!(buf, b"partial".to_vec());

    // Next chunk completes the line.
    buf.extend_from_slice(b" line\n");
    let lines = extract_lines(&mut buf);
    assert_eq!(lines, vec!["partial line"]);
    assert!(buf.is_empty());
}

#[test]
fn test_extract_lines_empty_input() {
    let mut buf: Vec<u8> = Vec::new();
    assert!(extract_lines(&mut buf).is_empty());
    // Bare delimiters yield no empty lines.
    let mut buf = b"\r\n\n".to_vec();
    assert!(extract_lines(&mut buf).is_empty());
    assert!(buf.is_empty());
}
