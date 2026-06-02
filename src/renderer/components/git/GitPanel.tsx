import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useGitStatusStore, diffKey } from "@/stores/git-status-store";
import { cn } from "@/lib/utils";
import { 
  FileCode, 
  FileText, 
  Plus, 
  Minus, 
  RotateCcw,
  ChevronDown,
  GitBranch,
  RefreshCw,
  Search,
  GitCommit,
  ArrowUp
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { GitFileStatus, GitStatusDetail } from "@shared/types/ipc.types";

interface GitPanelProps {
  cwd: string;
  isVisible: boolean;
}

type Section = "staged" | "unstaged";

export function GitPanel({ cwd, isVisible }: GitPanelProps) {
  const statuses = useGitStatusStore((state) => state.statuses);
  const diffs = useGitStatusStore((state) => state.diffs);
  const selectedFile = useGitStatusStore((state) => state.selectedFile);
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile);
  const refreshStatus = useGitStatusStore((state) => state.refreshStatus);
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff);
  const stageFiles = useGitStatusStore((state) => state.stageFiles);
  const unstageFiles = useGitStatusStore((state) => state.unstageFiles);
  const discardFiles = useGitStatusStore((state) => state.discardFiles);
  const isFetchingStatus = useGitStatusStore((state) => state.isFetchingStatus);
  const commitContexts = useGitStatusStore((state) => state.commitContexts);
  const fetchCommitContext = useGitStatusStore((state) => state.fetchCommitContext);
  const commit = useGitStatusStore((state) => state.commit);
  const push = useGitStatusStore((state) => state.push);

  const commitContext = commitContexts[cwd] ?? null;

  const [searchQuery, setSearchQuery] = useState("");
  // Track which side (staged vs unstaged) of the selected path is shown, since
  // an `MM` file appears in both sections under the same path.
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  // Multi-selection model. Selection is scoped to a single section (staged or
  // unstaged), since the same path can exist in both and they are staged /
  // unstaged independently. `anchorPath` is the pivot for shift-range selects.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectionSection, setSelectionSection] = useState<Section | null>(null);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  // Discard is confirmed through the app dialog; remember what it targets.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discardTargets, setDiscardTargets] = useState<string[]>([]);

  // Commit footer state.
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [confirmAmendOpen, setConfirmAmendOpen] = useState(false);
  // Synchronous in-flight guard so a same-tick double-click cannot dispatch two
  // commits before the isCommitting state has re-rendered.
  const commitInFlight = React.useRef(false);

  const currentDiff = selectedFile
    ? diffs[diffKey(cwd, selectedFile, selectedStaged)]
    : null;

  useEffect(() => {
    if (isVisible) {
      refreshStatus(cwd);
      fetchCommitContext(cwd);
    }
  }, [isVisible, cwd, refreshStatus, fetchCommitContext]);

  // Reset the commit footer and any multi-selection when the repo (cwd) changes
  // so half-typed messages or stale selections never carry over between repos.
  useEffect(() => {
    setSelectedFile(null);
    setSelectedStaged(false);
    setSummary("");
    setDescription("");
    setAmend(false);
    setConfirmAmendOpen(false);
    setSelectedPaths(new Set());
    setSelectionSection(null);
    setAnchorPath(null);
  }, [cwd, setSelectedFile]);

  useEffect(() => {
    if (!isVisible || !selectedFile) {
      return;
    }

    const key = diffKey(cwd, selectedFile, selectedStaged);
    if (!Object.prototype.hasOwnProperty.call(diffs, key)) {
      fetchDiff(cwd, selectedFile, selectedStaged);
    }
  }, [isVisible, selectedFile, selectedStaged, cwd, diffs, fetchDiff]);

  const filteredStatuses = useMemo(() => {
    const currentStatuses = statuses[cwd] || [];
    if (!searchQuery) return currentStatuses;
    return currentStatuses.filter((s: GitStatusDetail) => 
      s.path.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [statuses, cwd, searchQuery]);

  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged = filteredStatuses.filter((s: GitStatusDetail) => s.staged);
    const unstaged = filteredStatuses.filter((s: GitStatusDetail) => !s.staged);
    return { stagedFiles: staged, unstagedFiles: unstaged };
  }, [filteredStatuses]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionSection(null);
    setAnchorPath(null);
  }, []);

  // Click selection with VSCode-style modifiers:
  // - plain click  → select only this row
  // - ctrl/cmd     → toggle this row in the selection
  // - shift        → select the contiguous range from the anchor
  // Selection is always scoped to the clicked row's section.
  const handleFileClick = useCallback(
    (
      e: React.MouseEvent | React.KeyboardEvent,
      path: string,
      staged: boolean,
      sectionFiles: GitStatusDetail[],
    ) => {
      const section: Section = staged ? "staged" : "unstaged";
      const sameSection = selectionSection === section;

      if (e.shiftKey && sameSection && anchorPath) {
        const paths = sectionFiles.map((f) => f.path);
        const a = paths.indexOf(anchorPath);
        const b = paths.indexOf(path);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelectedPaths(new Set(paths.slice(lo, hi + 1)));
          setSelectionSection(section);
        }
      } else if (e.ctrlKey || e.metaKey) {
        const next = new Set(sameSection ? selectedPaths : []);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        setSelectedPaths(next);
        setSelectionSection(next.size > 0 ? section : null);
        setAnchorPath(path);
      } else {
        setSelectedPaths(new Set([path]));
        setSelectionSection(section);
        setAnchorPath(path);
      }

      // The diff view always follows the most-recently clicked row.
      setSelectedFile(path);
      setSelectedStaged(staged);
    },
    [selectionSection, selectedPaths, anchorPath, setSelectedFile],
  );

  // Resolve the paths an inline row action should affect: when the row is part
  // of an active multi-selection in its section, act on the whole selection;
  // otherwise act on just that row.
  const targetsFor = useCallback(
    (path: string, section: Section): string[] => {
      if (
        selectionSection === section &&
        selectedPaths.size > 0 &&
        selectedPaths.has(path)
      ) {
        return [...selectedPaths];
      }
      return [path];
    },
    [selectionSection, selectedPaths],
  );

  const runStage = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setIsMutating(true);
      try {
        await stageFiles(cwd, paths);
        clearSelection();
        if (selectedFile && paths.includes(selectedFile)) {
          setSelectedStaged(true);
        }
      } catch (error) {
        toast.error(`Failed to stage: ${String(error)}`);
      } finally {
        setIsMutating(false);
      }
    },
    [cwd, stageFiles, clearSelection, selectedFile],
  );

  const runUnstage = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setIsMutating(true);
      try {
        await unstageFiles(cwd, paths);
        clearSelection();
        if (selectedFile && paths.includes(selectedFile)) {
          setSelectedStaged(false);
        }
      } catch (error) {
        toast.error(`Failed to unstage: ${String(error)}`);
      } finally {
        setIsMutating(false);
      }
    },
    [cwd, unstageFiles, clearSelection, selectedFile],
  );

  // Discard only reverts unstaged (working-tree) changes, so it is only ever
  // offered for unstaged rows. Confirm before destroying work.
  const requestDiscard = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setDiscardTargets(paths);
    setConfirmDiscardOpen(true);
  }, []);

  const confirmDiscard = useCallback(async () => {
    if (discardTargets.length === 0) return;
    setIsMutating(true);
    try {
      await discardFiles(cwd, discardTargets);
      if (selectedFile && discardTargets.includes(selectedFile)) {
        setSelectedFile(null);
        setSelectedStaged(false);
      }
      clearSelection();
    } catch (error) {
      toast.error(`Failed to discard changes: ${String(error)}`);
    } finally {
      setIsMutating(false);
      setConfirmDiscardOpen(false);
      setDiscardTargets([]);
    }
  }, [cwd, discardTargets, discardFiles, selectedFile, setSelectedFile, clearSelection]);

  // Toggling amend on prefills the message from the last commit so the user can
  // reword it — but only when the inputs are empty, so we never clobber text the
  // user already typed. Toggling off clears a prefill that the user did not edit.
  const handleToggleAmend = () => {
    const next = !amend;
    setAmend(next);
    if (next && commitContext?.hasHead) {
      if (summary.trim() === "" && description.trim() === "") {
        setSummary(commitContext.lastSubject);
        setDescription(commitContext.lastBody);
      }
    } else if (!next) {
      // Only auto-clear if the inputs still match the prefilled last commit
      // (i.e. the user did not type their own message over it).
      if (
        summary === (commitContext?.lastSubject ?? "") &&
        description === (commitContext?.lastBody ?? "")
      ) {
        setSummary("");
        setDescription("");
      }
    }
  };

  const stagedCount = commitContext?.stagedCount ?? 0;
  const canCommit =
    summary.trim().length > 0 &&
    !isCommitting &&
    !isPushing &&
    (amend ? !!commitContext?.hasHead : stagedCount > 0);

  const runCommit = async () => {
    if (commitInFlight.current) return;
    commitInFlight.current = true;
    setIsCommitting(true);
    try {
      await commit(cwd, summary, description, amend);
      setSummary("");
      setDescription("");
      setAmend(false);
      toast.success(amend ? "Commit amended" : "Changes committed");
    } catch (error) {
      toast.error(`Failed to commit: ${String(error)}`);
    } finally {
      setIsCommitting(false);
      setConfirmAmendOpen(false);
      commitInFlight.current = false;
    }
  };

  const handleCommit = () => {
    if (!canCommit || commitInFlight.current) return;
    // Amending a commit that already matches the upstream rewrites published
    // history; gate it behind a confirmation.
    if (amend && commitContext?.hasUpstream && commitContext.ahead === 0) {
      setConfirmAmendOpen(true);
      return;
    }
    void runCommit();
  };

  const handlePush = async () => {
    if (isPushing || isCommitting) return;
    setIsPushing(true);
    try {
      await push(cwd);
      toast.success("Pushed to remote");
    } catch (error) {
      toast.error(`Failed to push: ${String(error)}`);
    } finally {
      setIsPushing(false);
    }
  };

  const onBranch = !!commitContext?.branch;
  const ahead = commitContext?.ahead ?? 0;
  const behind = commitContext?.behind ?? 0;
  // Once an upstream exists, there is nothing to push when we are not ahead.
  // Before an upstream exists, publishing is always meaningful.
  const hasSomethingToPush = !commitContext?.hasUpstream || ahead > 0;
  const canPush = onBranch && hasSomethingToPush && !isPushing && !isCommitting;
  const pushLabel = !commitContext?.hasUpstream
    ? "Publish branch"
    : ahead > 0
      ? `Push ${ahead}`
      : "Up to date";

  const getFileIcon = (status: GitFileStatus) => {
    switch (status) {
      case "added": return <Plus className="text-green-500" size={14} />;
      case "modified": return <div className="w-3.5 h-3.5 border-2 border-amber-500 rounded-full" />;
      case "deleted": return <Minus className="text-red-500" size={14} />;
      case "renamed": return <RotateCcw className="text-blue-500" size={14} />;
      default: return <FileCode size={14} />;
    }
  };

  const stagedSelectionCount =
    selectionSection === "staged" ? selectedPaths.size : 0;
  const unstagedSelectionCount =
    selectionSection === "unstaged" ? selectedPaths.size : 0;

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {/* File List Sidebar */}
      <div className="w-80 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
            <input
              type="text"
              placeholder="Filter changes..."
              className="w-full bg-secondary/50 border-none rounded-md py-1.5 pl-8 pr-3 text-xs focus:ring-1 focus:ring-primary outline-none"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8" 
            onClick={() => {
              refreshStatus(cwd);
              fetchCommitContext(cwd);
            }}
            disabled={isFetchingStatus}
          >
            <RefreshCw className={cn("h-4 w-4", isFetchingStatus && "animate-spin")} />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-4">
            {stagedFiles.length > 0 && (
              <div className="space-y-1">
                <SectionHeader
                  label="Staged Changes"
                  count={stagedFiles.length}
                  selectionCount={stagedSelectionCount}
                >
                  <SectionAction
                    icon={<Minus size={13} />}
                    label="Unstage all changes"
                    disabled={isMutating}
                    onClick={() => runUnstage(stagedFiles.map((f) => f.path))}
                  />
                </SectionHeader>
                {stagedFiles.map((file: GitStatusDetail) => {
                  const inSelection =
                    selectionSection === "staged" && selectedPaths.has(file.path);
                  return (
                    <FileItem
                      key={file.path}
                      file={file}
                      isActive={selectedFile === file.path && selectedStaged}
                      isSelected={inSelection}
                      onClick={(e) => handleFileClick(e, file.path, true, stagedFiles)}
                      icon={getFileIcon(file.status)}
                    >
                      <RowAction
                        icon={<Minus size={13} />}
                        label="Unstage changes"
                        disabled={isMutating}
                        onClick={() => runUnstage(targetsFor(file.path, "staged"))}
                      />
                    </FileItem>
                  );
                })}
              </div>
            )}

            <div className="space-y-1">
              <SectionHeader
                label="Changes"
                count={unstagedFiles.length}
                selectionCount={unstagedSelectionCount}
              >
                {unstagedFiles.length > 0 && (
                  <>
                    <SectionAction
                      icon={<RotateCcw size={13} />}
                      label="Discard all changes"
                      variant="danger"
                      disabled={isMutating}
                      onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                    />
                    <SectionAction
                      icon={<Plus size={13} />}
                      label="Stage all changes"
                      disabled={isMutating}
                      onClick={() => runStage(unstagedFiles.map((f) => f.path))}
                    />
                  </>
                )}
              </SectionHeader>
              {unstagedFiles.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">No changes detected</p>
                </div>
              ) : (
                unstagedFiles.map((file: GitStatusDetail) => {
                  const inSelection =
                    selectionSection === "unstaged" && selectedPaths.has(file.path);
                  return (
                    <FileItem
                      key={file.path}
                      file={file}
                      isActive={selectedFile === file.path && !selectedStaged}
                      isSelected={inSelection}
                      onClick={(e) => handleFileClick(e, file.path, false, unstagedFiles)}
                      icon={getFileIcon(file.status)}
                    >
                      <RowAction
                        icon={<RotateCcw size={13} />}
                        label="Discard changes"
                        variant="danger"
                        disabled={isMutating}
                        onClick={() => requestDiscard(targetsFor(file.path, "unstaged"))}
                      />
                      <RowAction
                        icon={<Plus size={13} />}
                        label="Stage changes"
                        disabled={isMutating}
                        onClick={() => runStage(targetsFor(file.path, "unstaged"))}
                      />
                    </FileItem>
                  );
                })
              )}
            </div>
          </div>
        </ScrollArea>

        {/* Commit footer (GitHub Desktop style) */}
        <div className="border-t border-border p-3 space-y-2 bg-background/60">
          <input
            type="text"
            aria-label="Commit summary"
            placeholder={amend ? "Update commit message" : "Summary (required)"}
            className="w-full bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={isCommitting}
          />
          <textarea
            aria-label="Commit description"
            placeholder="Description (optional)"
            rows={3}
            className="w-full resize-none bg-secondary/50 border-none rounded-md py-1.5 px-3 text-xs focus:ring-1 focus:ring-primary outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isCommitting}
          />
          <label
            className={cn(
              "flex items-center gap-2 text-[11px] select-none",
              commitContext?.hasHead
                ? "text-muted-foreground cursor-pointer"
                : "text-muted-foreground/40 cursor-not-allowed",
            )}
            title={
              commitContext?.hasHead
                ? "Amend the last commit instead of creating a new one"
                : "No commit to amend yet"
            }
          >
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={amend}
              onChange={handleToggleAmend}
              disabled={!commitContext?.hasHead || isCommitting}
            />
            Amend last commit
          </label>
          <Button
            variant="default"
            size="sm"
            className="w-full h-8 text-xs gap-2"
            onClick={handleCommit}
            disabled={!canCommit}
            title={
              amend
                ? "Amend the last commit"
                : stagedCount === 0
                  ? "Stage files to commit"
                  : "Commit staged changes"
            }
          >
            <GitCommit size={14} />
            {isCommitting
              ? "Committing..."
              : amend
                ? "Amend commit"
                : commitContext?.branch
                  ? `Commit to ${commitContext.branch}`
                  : "Commit"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full h-8 text-xs gap-2"
            onClick={handlePush}
            disabled={!canPush}
            title={
              !onBranch
                ? "Not on a branch (detached HEAD)"
                : !commitContext?.hasUpstream
                  ? "Publish this branch to origin"
                  : ahead > 0
                    ? "Push commits to the remote"
                    : "Nothing to push — up to date with the remote"
            }
          >
            <ArrowUp size={14} className={cn(isPushing && "animate-pulse")} />
            {isPushing ? "Pushing..." : pushLabel}
            {behind > 0 && (
              <span className="text-[10px] text-amber-500">↓{behind}</span>
            )}
          </Button>
        </div>
      </div>

      {/* Diff View */}
      <div className="flex-1 flex flex-col min-w-0 bg-card/30">
        {selectedFile ? (
          <>
            <div className="p-3 border-b border-border flex items-center justify-between bg-background">
              <div className="flex items-center gap-3 overflow-hidden">
                <FileCode size={16} className="text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{selectedFile}</span>
              </div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
                {selectedStaged ? "Staged" : "Working tree"}
              </span>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff === undefined || currentDiff === null ? (
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <RefreshCw className="animate-spin mr-2" size={16} />
                  Loading diff...
                </div>
              ) : currentDiff.trim().length > 0 ? (
                <div className="p-4 whitespace-pre" style={{ tabSize: 4, MozTabSize: 4 }}>
                  {currentDiff.split('\n').map((line: string, i: number) => {
                    const isAddition = line.startsWith('+');
                    const isDeletion = line.startsWith('-');
                    const isHeader = line.startsWith('@@') || line.startsWith('diff') || line.startsWith('index');
                    
                    return (
                      <div 
                        key={i} 
                        className={cn(
                          "px-2 py-0.5",
                          isAddition && "bg-green-500/10 text-green-400",
                          isDeletion && "bg-red-500/10 text-red-400",
                          isHeader && "text-muted-foreground italic bg-muted/20"
                        )}
                      >
                        {line || ' '}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60">
                    <FileText size={18} />
                  </div>
                  <h3 className="text-sm font-medium text-foreground mb-1">No diff available</h3>
                  <p className="text-xs max-w-[260px]">
                    This file may be ignored by Git, unchanged relative to the selected base, or unavailable for diff preview.
                  </p>
                </div>
              )}
            </ScrollArea>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4 text-muted-foreground/50">
              <GitBranch size={24} />
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">Select a file to see changes</h3>
            <p className="text-xs max-w-[240px]">
              Click on any modified file in the sidebar to view the diff and manage your changes.
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        variant="danger"
        title="Discard changes"
        message={
          discardTargets.length > 1
            ? `Discard changes to ${discardTargets.length} files? This cannot be undone.`
            : discardTargets[0]
              ? `Discard changes to "${discardTargets[0]}"? This cannot be undone.`
              : ""
        }
        confirmLabel="Discard"
        isLoading={isMutating}
        onConfirm={confirmDiscard}
        onCancel={() => {
          setConfirmDiscardOpen(false);
          setDiscardTargets([]);
        }}
      />

      <ConfirmDialog
        isOpen={confirmAmendOpen}
        variant="danger"
        title="Amend pushed commit"
        message="The last commit appears to already be pushed. Amending rewrites published history and will require a force-push to update the remote. Continue?"
        confirmLabel="Amend anyway"
        isLoading={isCommitting}
        onConfirm={runCommit}
        onCancel={() => setConfirmAmendOpen(false)}
      />
    </div>
  );
}

function SectionHeader({
  label,
  count,
  selectionCount,
  children,
}: {
  label: string;
  count: number;
  selectionCount: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="group/section flex items-center justify-between px-2 py-1">
      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <ChevronDown size={12} />
        {label} ({count})
        {selectionCount > 1 && (
          <span className="text-primary normal-case font-medium">
            · {selectionCount} selected
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-60 group-hover/section:opacity-100 focus-within:opacity-100 transition-opacity">
        {children}
      </div>
    </div>
  );
}

function SectionAction({
  icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        variant === "danger"
          ? "text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  disabled,
  variant,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}) {
  // Stop the click from bubbling to the row, which would otherwise change the
  // selection / diff target instead of running the action.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick();
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={handleClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        variant === "danger"
          ? "text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

function FileItem({ file, isActive, isSelected, onClick, icon, children }: {
  file: { path: string, status: GitFileStatus },
  isActive: boolean,
  isSelected: boolean,
  onClick: (e: React.MouseEvent | React.KeyboardEvent) => void,
  icon: React.ReactNode,
  children?: React.ReactNode,
}) {
  const fileName = file.path.split('/').pop() || file.path;
  const dirName = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget !== e.target) {
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(e);
    }
  };

  return (
    <div
      role="option"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-selected={isSelected || isActive}
      className={cn(
        "group/row flex w-full items-center gap-3 px-3 py-2 rounded-md text-left cursor-pointer transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        isSelected
          ? "bg-primary/15 text-foreground"
          : isActive
            ? "bg-primary/10 text-primary"
            : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground",
      )}
    >
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-[11px] font-medium truncate leading-tight">{fileName}</span>
        {dirName && <span className="text-[9px] truncate opacity-50 leading-tight">{dirName}</span>}
      </div>
      <div
        className={cn(
          "flex items-center gap-0.5 transition-opacity focus-within:opacity-100",
          isSelected || isActive
            ? "opacity-100"
            : "opacity-60 group-hover/row:opacity-100",
        )}
      >
        {children}
      </div>
      <div className={cn(
        "text-[10px] uppercase font-bold px-1 rounded shrink-0",
        file.status === 'added' && "text-green-500",
        file.status === 'modified' && "text-amber-500",
        file.status === 'deleted' && "text-red-500",
        file.status === 'renamed' && "text-blue-500",
      )}>
        {file.status === 'modified' ? 'M' : file.status.charAt(0).toUpperCase()}
      </div>
    </div>
  );
}
