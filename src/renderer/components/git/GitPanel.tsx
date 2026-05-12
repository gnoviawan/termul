import React, { useEffect, useState, useMemo } from "react";
import { useGitStatusStore } from "@/stores/git-status-store";
import { cn } from "@/lib/utils";
import { 
  FileCode, 
  FileText, 
  Plus, 
  Minus, 
  RotateCcw,
  Check,
  ChevronRight,
  ChevronDown,
  GitBranch,
  RefreshCw,
  Search
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { gitApi } from "@/lib/git-api";
import { toast } from "sonner";
import { GitFileStatus, GitStatusDetail } from "@shared/types/ipc.types";

interface GitPanelProps {
  cwd: string;
  isVisible: boolean;
}

export function GitPanel({ cwd, isVisible }: GitPanelProps) {
  const statuses = useGitStatusStore((state) => state.statuses);
  const diffs = useGitStatusStore((state) => state.diffs);
  const selectedFile = useGitStatusStore((state) => state.selectedFile);
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile);
  const refreshStatus = useGitStatusStore((state) => state.refreshStatus);
  const fetchDiff = useGitStatusStore((state) => state.fetchDiff);
  const isFetchingStatus = useGitStatusStore((state) => state.isFetchingStatus);

  const [searchQuery, setSearchQuery] = useState("");
  
  const currentDiff = selectedFile ? diffs[`${cwd}:${selectedFile}`] : null;

  useEffect(() => {
    if (isVisible) {
      refreshStatus(cwd);
    }
  }, [isVisible, cwd, refreshStatus]);

  useEffect(() => {
    if (isVisible && selectedFile && !diffs[`${cwd}:${selectedFile}`]) {
      fetchDiff(cwd, selectedFile);
    }
  }, [isVisible, selectedFile, cwd, diffs, fetchDiff]);

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

  const handleFileClick = (path: string) => {
    setSelectedFile(path);
    fetchDiff(cwd, path);
  };

  const getFileIcon = (status: GitFileStatus) => {
    switch (status) {
      case "added": return <Plus className="text-green-500" size={14} />;
      case "modified": return <div className="w-3.5 h-3.5 border-2 border-amber-500 rounded-full" />;
      case "deleted": return <Minus className="text-red-500" size={14} />;
      case "renamed": return <RotateCcw className="text-blue-500" size={14} />;
      default: return <FileCode size={14} />;
    }
  };

  return (
    <div className="flex h-full w-full bg-background overflow-hidden border-t border-border">
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
            onClick={() => refreshStatus(cwd)}
            disabled={isFetchingStatus}
          >
            <RefreshCw className={cn("h-4 w-4", isFetchingStatus && "animate-spin")} />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-4">
            {stagedFiles.length > 0 && (
              <div className="space-y-1">
                <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <ChevronDown size={12} />
                  Staged Changes
                </div>
                {stagedFiles.map((file: GitStatusDetail) => (
                  <FileItem 
                    key={file.path} 
                    file={file} 
                    isSelected={selectedFile === file.path}
                    onClick={() => handleFileClick(file.path)}
                    icon={getFileIcon(file.status)}
                  />
                ))}
              </div>
            )}

            <div className="space-y-1">
              <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <ChevronDown size={12} />
                Changes ({unstagedFiles.length})
              </div>
              {unstagedFiles.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">No changes detected</p>
                </div>
              ) : (
                unstagedFiles.map((file: GitStatusDetail) => (
                  <FileItem 
                    key={file.path} 
                    file={file} 
                    isSelected={selectedFile === file.path}
                    onClick={() => handleFileClick(file.path)}
                    icon={getFileIcon(file.status)}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
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
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8 text-xs gap-2">
                   Discard
                </Button>
                <Button variant="default" size="sm" className="h-8 text-xs gap-2">
                   Stage
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1 font-mono text-xs">
              {currentDiff ? (
                <div className="p-4 whitespace-pre">
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
                <div className="h-full flex items-center justify-center text-muted-foreground">
                  <RefreshCw className="animate-spin mr-2" size={16} />
                  Loading diff...
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
    </div>
  );
}

function FileItem({ file, isSelected, onClick, icon }: { 
  file: { path: string, status: GitFileStatus }, 
  isSelected: boolean, 
  onClick: () => void,
  icon: React.ReactNode
}) {
  const fileName = file.path.split('/').pop() || file.path;
  const dirName = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';

  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors group",
        isSelected 
          ? "bg-primary/10 text-primary" 
          : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
      )}
    >
      <div className="shrink-0">{icon}</div>
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-[11px] font-medium truncate leading-tight">{fileName}</span>
        {dirName && <span className="text-[9px] truncate opacity-50 leading-tight">{dirName}</span>}
      </div>
      <div className={cn(
        "text-[10px] uppercase font-bold px-1 rounded",
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
