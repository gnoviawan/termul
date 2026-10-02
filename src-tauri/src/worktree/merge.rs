use super::*;

impl WorktreeManager {
    /// Generate a merge preview by running `git merge --no-commit --no-ff --dry-run`.
    /// Parses output to identify conflicting and changed files.
    /// Analyzes conflicts and provides resolution suggestions.
    pub fn merge_preview(
        worktree_path: &str,
        target_branch: &str,
    ) -> Result<MergePreview, WorktreeError> {
        let current_branch = Self::get_current_branch(worktree_path)?;

        // Try accurate detection first
        match run_git(
            &[
                "merge",
                "--no-commit",
                "--no-ff",
                "--dry-run",
                target_branch,
            ],
            Some(worktree_path),
        ) {
            Ok((stdout, _stderr)) => {
                // Parse git diff-tree --stat style output for changed files
                let changed = stdout
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>();

                Ok(MergePreview {
                    direction: format!("{} → {}", current_branch, target_branch),
                    source_branch: current_branch,
                    target_branch: target_branch.to_string(),
                    conflict_files: Vec::new(),
                    changed_files: changed.clone(),
                    total_changes: changed.len(),
                    detection_mode: "accurate".to_string(),
                    has_auto_resolvable: false,
                })
            }
            Err(e) => {
                // Check if the error is due to conflicts
                let err_str = e.to_string();
                if err_str.contains("conflict") || err_str.contains("merge failed") {
                    // Fast detection fallback: check `git status --porcelain`
                    let conflict_files = Self::detect_conflict_files(worktree_path)?;

                    // Check if any conflicts have high-confidence auto-resolution suggestions
                    let has_auto_resolvable = conflict_files.iter().any(|cf| {
                        cf.suggestions
                            .iter()
                            .any(|s| s.confidence == "high" && s.strategy != "manual")
                    });

                    Ok(MergePreview {
                        direction: format!("{} → {}", current_branch, target_branch),
                        source_branch: current_branch,
                        target_branch: target_branch.to_string(),
                        conflict_files,
                        changed_files: Vec::new(),
                        total_changes: 0,
                        detection_mode: "fast".to_string(),
                        has_auto_resolvable,
                    })
                } else {
                    Err(WorktreeError::MergeFailed)
                }
            }
        }
    }

    /// Execute a merge from the worktree's current branch to target_branch.
    pub fn merge_execute(
        worktree_path: &str,
        target_branch: &str,
    ) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["merge", target_branch], Some(worktree_path))
            .map_err(|_| WorktreeError::MergeFailed)?;
        Ok(stdout.trim().to_string())
    }

    /// Get the current branch name of a git repo.
    fn get_current_branch(worktree_path: &str) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(worktree_path))?;
        Ok(stdout.trim().to_string())
    }

    /// Get the branch name of a worktree by reading its git HEAD.
    pub(super) fn get_worktree_branch(worktree_path: &str) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(worktree_path))?;
        let branch = stdout.trim().to_string();
        if branch == "HEAD" {
            Err(WorktreeError::BranchNotFound)
        } else {
            Ok(branch)
        }
    }

    /// Detect conflict files by parsing `git status --porcelain` for conflicted entries.
    /// Also analyzes conflict content and generates resolution suggestions.
    fn detect_conflict_files(worktree_path: &str) -> Result<Vec<ConflictFile>, WorktreeError> {
        let (stdout, _) = run_git(&["status", "--porcelain"], Some(worktree_path))?;
        let mut conflict_files = Vec::new();

        // Porcelain format: XY filename
        // Conflicted entries have status codes: DD, AU, UD, UA, DU, AA, UU
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.len() >= 2 {
                let code = &trimmed[..2];
                let path = trimmed[3..].trim();

                // Unmerged/conflicted paths start with U or have DD/AA
                let is_conflict = code.contains('U') || code == "DD" || code == "AA";
                if is_conflict && !path.is_empty() {
                    let is_lock = path.ends_with(".lock")
                        || path.contains("package-lock")
                        || path.contains("yarn.lock");
                    let suggestions =
                        Self::analyze_conflict_and_suggest(worktree_path, path, is_lock);

                    conflict_files.push(ConflictFile {
                        path: path.to_string(),
                        severity: if is_lock {
                            "low".to_string()
                        } else {
                            "high".to_string()
                        },
                        conflict_count: 1,
                        is_lock_file: is_lock,
                        suggestions,
                    });
                }
            }
        }

        Ok(conflict_files)
    }

    /// Analyze a conflict file and generate resolution suggestions.
    /// Detects patterns like whitespace-only, import reordering, lockfile version bumps, etc.
    pub(super) fn analyze_conflict_and_suggest(
        worktree_path: &str,
        file_path: &str,
        is_lock_file: bool,
    ) -> Vec<ConflictSuggestion> {
        let mut suggestions = Vec::new();

        // Lockfile conflicts: suggest accepting newer version
        if is_lock_file {
            suggestions.push(ConflictSuggestion {
                strategy: "accept-theirs".to_string(),
                confidence: "high".to_string(),
                reason: "lockfile-version-bump".to_string(),
                description: "Lockfile conflicts typically require accepting the target branch version and re-running install.".to_string(),
            });
            suggestions.push(ConflictSuggestion {
                strategy: "regenerate".to_string(),
                confidence: "high".to_string(),
                reason: "lockfile-regenerate".to_string(),
                description: "Delete lockfile and regenerate after merge to ensure consistency."
                    .to_string(),
            });
            return suggestions;
        }

        // Try to read the conflicted file content
        let full_path = std::path::Path::new(worktree_path).join(file_path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => return suggestions, // Can't read, return empty suggestions
        };

        // Check if file has conflict markers
        if !content.contains("<<<<<<<") || !content.contains(">>>>>>>") {
            return suggestions;
        }

        // Analyze conflict patterns
        let conflict_blocks = Self::extract_conflict_blocks(&content);

        for block in &conflict_blocks {
            // Check for whitespace-only differences
            if Self::is_whitespace_only_conflict(&block.ours, &block.theirs) {
                suggestions.push(ConflictSuggestion {
                    strategy: "auto-format".to_string(),
                    confidence: "high".to_string(),
                    reason: "whitespace-only".to_string(),
                    description: "Differences are whitespace-only. Auto-format after accepting either version.".to_string(),
                });
            }

            // Check for import reordering (common in JS/TS/Python)
            if Self::is_import_reorder_conflict(&block.ours, &block.theirs) {
                suggestions.push(ConflictSuggestion {
                    strategy: "auto-sort-imports".to_string(),
                    confidence: "medium".to_string(),
                    reason: "import-reorder".to_string(),
                    description: "Both sides have imports in different order. Run import sorting tool after merge.".to_string(),
                });
            }

            // Check for same edit on both sides
            if Self::are_changes_identical(&block.ours, &block.theirs) {
                suggestions.push(ConflictSuggestion {
                    strategy: "accept-either".to_string(),
                    confidence: "high".to_string(),
                    reason: "identical-changes".to_string(),
                    description: "Both branches made the same change. Accept either version."
                        .to_string(),
                });
            }

            // Check for trivial formatting differences
            if Self::is_trivial_formatting(&block.ours, &block.theirs) {
                suggestions.push(ConflictSuggestion {
                    strategy: "accept-ours-then-format".to_string(),
                    confidence: "medium".to_string(),
                    reason: "trivial-formatting".to_string(),
                    description:
                        "Differences are mostly formatting. Accept one side and run formatter."
                            .to_string(),
                });
            }
        }

        // Deduplicate suggestions by (strategy, reason) key
        let mut seen = std::collections::HashSet::new();
        suggestions.retain(|s| seen.insert((s.strategy.clone(), s.reason.clone())));

        // If no auto-resolution suggestions, provide manual guidance
        if suggestions.is_empty() {
            suggestions.push(ConflictSuggestion {
                strategy: "manual".to_string(),
                confidence: "low".to_string(),
                reason: "complex-conflict".to_string(),
                description: "Complex conflict requiring manual review of both changes."
                    .to_string(),
            });
        }

        suggestions
    }

    /// Extract conflict blocks from file content with conflict markers.
    pub(super) fn extract_conflict_blocks(content: &str) -> Vec<ConflictBlock> {
        let mut blocks = Vec::new();
        let lines: Vec<&str> = content.lines().collect();
        let mut i = 0;

        while i < lines.len() {
            if lines[i].starts_with("<<<<<<<") {
                let mut ours = Vec::new();
                let mut theirs = Vec::new();
                let mut base = Vec::new();
                i += 1;

                // Collect "ours" section
                while i < lines.len()
                    && !lines[i].starts_with("|||||||")
                    && !lines[i].starts_with("=======")
                {
                    ours.push(lines[i]);
                    i += 1;
                }

                // Check for base section (diff3 style)
                if i < lines.len() && lines[i].starts_with("|||||||") {
                    i += 1;
                    while i < lines.len() && !lines[i].starts_with("=======") {
                        base.push(lines[i]);
                        i += 1;
                    }
                }

                // Skip separator
                if i < lines.len() && lines[i].starts_with("=======") {
                    i += 1;
                }

                // Collect "theirs" section
                while i < lines.len() && !lines[i].starts_with(">>>>>>>") {
                    theirs.push(lines[i]);
                    i += 1;
                }

                blocks.push(ConflictBlock {
                    ours: ours.join("\n"),
                    theirs: theirs.join("\n"),
                    base: base.join("\n"),
                });
            }
            i += 1;
        }

        blocks
    }

    /// Check if conflict is whitespace-only.
    pub(super) fn is_whitespace_only_conflict(ours: &str, theirs: &str) -> bool {
        let ours_normalized: String = ours.chars().filter(|c| !c.is_whitespace()).collect();
        let theirs_normalized: String = theirs.chars().filter(|c| !c.is_whitespace()).collect();
        ours_normalized == theirs_normalized && !ours_normalized.is_empty()
    }

    /// Check if both sides made identical changes.
    pub(super) fn are_changes_identical(ours: &str, theirs: &str) -> bool {
        ours.trim() == theirs.trim() && !ours.trim().is_empty()
    }

    /// Check if conflict is due to import reordering.
    pub(super) fn is_import_reorder_conflict(ours: &str, theirs: &str) -> bool {
        let import_keywords = ["import ", "from ", "require(", "use ", "#include"];
        let has_imports = import_keywords
            .iter()
            .any(|kw| ours.contains(kw) || theirs.contains(kw));

        if !has_imports {
            return false;
        }

        // Check if lines are the same but in different order
        let mut ours_lines: Vec<&str> = ours
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let mut theirs_lines: Vec<&str> = theirs
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();

        ours_lines.sort_unstable();
        theirs_lines.sort_unstable();

        ours_lines == theirs_lines && !ours_lines.is_empty()
    }

    /// Check if differences are trivial formatting (quotes, semicolons, trailing commas).
    pub(super) fn is_trivial_formatting(ours: &str, theirs: &str) -> bool {
        // Normalize by removing common formatting differences
        let normalize = |s: &str| -> String {
            s.replace("\"", "'")
                .replace(";", "")
                .replace(",\n", "\n")
                .replace(", ", " ")
                // Remove trailing commas before closing delimiters
                .replace(",]", "]")
                .replace(",}", "}")
                .replace(",)", ")")
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect()
        };

        let ours_norm = normalize(ours);
        let theirs_norm = normalize(theirs);

        ours_norm == theirs_norm && !ours_norm.is_empty()
    }
}
