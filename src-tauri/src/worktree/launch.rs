use std::path::Path;

use super::*;

impl WorktreeManager {
    // ========================================================================
    // CAP-2: Origin-aware default base branch resolution + detached-HEAD guard
    // ========================================================================

    /// Resolve the default base branch for a new `chat/{id}` worktree.
    ///
    /// Order: `refs/remotes/origin/HEAD` → `main` → `master` → current branch.
    /// `is_detached` is `true` when `git rev-parse --abbrev-ref HEAD` returns
    /// `HEAD` (the launcher must then force a base-branch pick).
    pub fn resolve_default_base_branch(
        project_path: &str,
    ) -> Result<BaseBranchInfo, WorktreeError> {
        let (current_stdout, _) =
            run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(project_path))?;
        let current_raw = current_stdout.trim().to_string();
        let is_detached = current_raw == "HEAD";
        let current_branch = if is_detached {
            None
        } else {
            Some(current_raw.clone())
        };

        // 1. origin/HEAD (symbolic-ref --short). `symbolic-ref --short` returns
        // the remote-tracking short name (e.g. `origin/main`); strip the
        // `origin/` qualifier so the result lives in the local-branch
        // namespace the launcher's base picker compares against.
        let origin_default = run_git(
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            Some(project_path),
        )
        .map(|(out, _)| out.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix("origin/").unwrap_or(&s).to_string());

        // 2/3. main / master if they exist as local branches
        let has_branch = |name: &str| -> bool {
            run_git(
                &["rev-parse", "--verify", &format!("refs/heads/{name}")],
                Some(project_path),
            )
            .map(|(o, _)| o.trim().to_string())
            .is_ok_and(|s| !s.is_empty())
        };

        let default_base = origin_default
            .or_else(|| {
                if has_branch("main") {
                    Some("main".to_string())
                } else {
                    None
                }
            })
            .or_else(|| {
                if has_branch("master") {
                    Some("master".to_string())
                } else {
                    None
                }
            })
            .or_else(|| current_branch.clone())
            // Final fallback: the detached raw value ("HEAD") is meaningless as
            // a base; fall back to "main" as a safe default the launcher can
            // override via the explicit CAP-2 picker.
            .unwrap_or_else(|| "main".to_string());

        Ok(BaseBranchInfo {
            default_base,
            current_branch,
            is_detached,
        })
    }

    // ========================================================================
    // CAP-5: `.worktree-include` carry-over (bb pattern, symlink/escape defenses)
    // ========================================================================

    /// Copy untracked files listed in `.worktree-include` into a fresh worktree.
    ///
    /// Defenses (bb `copyWorktreeIncludeFiles`): skip symlinks, verify the
    /// destination realpath is inside the worktree realpath (path-escape
    /// defense), `COPYFILE_EXCL` (skip already-present), mkdir parent only
    /// inside the worktree. Returns `{ ran, copied, skipped }` with per-file
    /// skip reasons. Missing `.worktree-include` is a no-op (`ran=0`).
    pub fn copy_worktree_include_files(
        project_path: &str,
        worktree_path: &str,
    ) -> Result<IncludeCopyResult, WorktreeError> {
        let include_path = Path::new(project_path).join(".worktree-include");
        if !include_path.exists() {
            log::debug!(
                "[worktree-include] no .worktree-include at {}, skipping carry-over",
                include_path.display()
            );
            return Ok(IncludeCopyResult {
                ran: 0,
                copied: 0,
                skipped: Vec::new(),
            });
        }

        let content = std::fs::read_to_string(&include_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        let patterns: Vec<String> = content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(String::from)
            .collect();

        if patterns.is_empty() {
            log::debug!(
                "[worktree-include] {} has no patterns, skipping carry-over",
                include_path.display()
            );
            return Ok(IncludeCopyResult {
                ran: 0,
                copied: 0,
                skipped: Vec::new(),
            });
        }

        let project_root = Path::new(project_path);
        let worktree_root = Path::new(worktree_path);
        let worktree_real = worktree_root
            .canonicalize()
            .map_err(|e| WorktreeError::IoError(format!("worktree realpath: {e}")))?;

        let mut result = IncludeCopyResult {
            ran: 0,
            copied: 0,
            skipped: Vec::new(),
        };

        // Compile all patterns once (avoid O(patterns × files) re-walks per
        // pattern). Invalid patterns are warned and skipped.
        let compiled: Vec<regex::Regex> = patterns
            .iter()
            .filter_map(|p| match glob_to_regex(p) {
                Ok(re) => Some(re),
                Err(error) => {
                    log::warn!("[worktree-include] invalid pattern '{p}': {error}");
                    None
                }
            })
            .collect();
        if compiled.is_empty() {
            log::debug!(
                "[worktree-include] {} has no valid patterns, skipping carry-over",
                include_path.display()
            );
            return Ok(result);
        }
        let mut matched = vec![false; compiled.len()];

        // Directories pruned at descent time (never recursed into).
        const PRUNE_DIRS: &[&str] = &[".git", ".termul", "node_modules", "target", "dist"];

        // Single recursive walk: each file is tested against every compiled
        // pattern (the first match copies it once; later matches only mark the
        // pattern as ran).
        let mut stack: Vec<std::path::PathBuf> = vec![project_root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(error) => {
                    log::debug!(
                        "[worktree-include] skip unreadable dir {}: {error}",
                        dir.display()
                    );
                    continue;
                }
            };
            for entry in entries.flatten() {
                let entry_path = entry.path();
                let ft = match entry.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };

                // Defense 1: symlinks (source side). On Unix `file_type()`
                // reports `is_symlink()` without following; on Windows the
                // `symlink_metadata` check is authoritative. A symlink is never
                // recursed into or copied — if a pattern matches its path it
                // is recorded as a symlink skip so the user sees the carry-over
                // declined it.
                let is_symlink = ft.is_symlink()
                    || std::fs::symlink_metadata(&entry_path)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false);
                if is_symlink {
                    let rel_str = match entry_path.strip_prefix(project_root) {
                        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                        Err(_) => continue,
                    };
                    if compiled.iter().any(|re| re.is_match(&rel_str)) {
                        log::debug!("[worktree-include] skip symlink '{}'", rel_str);
                        result.skipped.push(IncludeSkipReason {
                            path: rel_str,
                            reason: "symlink".to_string(),
                        });
                    }
                    continue;
                }

                if ft.is_dir() {
                    let name = entry_path.file_name().and_then(|n| n.to_str());
                    // Skip the worktree itself (compare canonicalized paths so a
                    // differently-spelled entry to the same worktree still
                    // prunes), repo metadata, and build/dep trees.
                    if name.is_some_and(|n| PRUNE_DIRS.contains(&n))
                        || entry_path
                            .canonicalize()
                            .map(|p| p == worktree_real)
                            .unwrap_or(false)
                    {
                        continue;
                    }
                    stack.push(entry_path);
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }
                let rel_str = match entry_path.strip_prefix(project_root) {
                    Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let mut hit = false;
                for (i, re) in compiled.iter().enumerate() {
                    if re.is_match(&rel_str) {
                        matched[i] = true;
                        hit = true;
                    }
                }
                if !hit {
                    continue;
                }
                let dest = worktree_root.join(&rel_str);

                // Defense 2: path-escape — the destination parent MUST
                // canonicalize to a real path inside the worktree. Reject
                // (skip) when canonicalization fails; never fall back to the
                // non-canonical parent, which could write outside the worktree.
                let dest_parent_real = match dest.parent().map(std::path::Path::canonicalize) {
                    Some(Ok(p)) => p,
                    _ => {
                        log::warn!("[worktree-include] skip path-escape '{}'", rel_str);
                        result.skipped.push(IncludeSkipReason {
                            path: rel_str.clone(),
                            reason: "path-escape".to_string(),
                        });
                        continue;
                    }
                };
                let dest_real = dest_parent_real.join(dest.file_name().unwrap_or_default());
                if !dest_real.starts_with(&worktree_real) {
                    log::warn!("[worktree-include] skip path-escape '{}'", rel_str);
                    result.skipped.push(IncludeSkipReason {
                        path: rel_str.clone(),
                        reason: "path-escape".to_string(),
                    });
                    continue;
                }

                // Defense 3: COPYFILE_EXCL — skip if already present.
                if dest.exists() {
                    result.skipped.push(IncludeSkipReason {
                        path: rel_str.clone(),
                        reason: "already-present".to_string(),
                    });
                    continue;
                }

                // mkdir parent (only inside the worktree).
                if let Some(parent) = dest.parent() {
                    if let Err(error) = std::fs::create_dir_all(parent) {
                        result.skipped.push(IncludeSkipReason {
                            path: rel_str.clone(),
                            reason: format!("mkdir failed: {error}"),
                        });
                        continue;
                    }
                }

                // Copy.
                if let Err(error) = std::fs::copy(&entry_path, &dest) {
                    result.skipped.push(IncludeSkipReason {
                        path: rel_str.clone(),
                        reason: format!("copy failed: {error}"),
                    });
                    continue;
                }
                log::debug!("[worktree-include] copied '{rel_str}'");
                result.copied += 1;
            }
        }
        result.ran = matched.iter().filter(|b| **b).count();

        log::info!(
            "[worktree-include] carry-over ran={} copied={} skipped={}",
            result.ran,
            result.copied,
            result.skipped.len()
        );
        Ok(result)
    }
}
