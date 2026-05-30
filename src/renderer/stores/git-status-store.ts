import { create } from "zustand";
import { toast } from "sonner";
import { gitApi } from "@/lib/git-api";
import { GitStatusDetail } from "@shared/types/ipc.types";

/** Build the staged-aware diff cache key so the staged and unstaged rows of the
 * same file (porcelain `MM`) do not collide. */
export const diffKey = (cwd: string, path: string, staged: boolean) =>
  `${cwd}:${path}:${staged}`;

export interface GitStatusState {
  // statuses[cwd] = GitStatusDetail[]
  statuses: Record<string, GitStatusDetail[]>;
  // diffs["cwd:path:staged"] = string
  diffs: Record<string, string>;
  selectedFile: string | null;
  isFetchingStatus: boolean;
  statusFetchCount: number;

  setSelectedFile: (path: string | null) => void;
  refreshStatus: (cwd: string) => Promise<void>;
  fetchDiff: (cwd: string, path: string, staged: boolean) => Promise<void>;
  stageFile: (cwd: string, path: string) => Promise<void>;
  unstageFile: (cwd: string, path: string) => Promise<void>;
  discardFile: (cwd: string, path: string) => Promise<void>;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statuses: {},
  diffs: {},
  selectedFile: null,
  isFetchingStatus: false,
  statusFetchCount: 0,

  setSelectedFile: (path) => set({ selectedFile: path }),

  refreshStatus: async (cwd) => {
    set((state) => ({
      statusFetchCount: state.statusFetchCount + 1,
      isFetchingStatus: true
    }));
    try {
      const status = await gitApi.getStatus(cwd);
      set((state) => ({
        statuses: { ...state.statuses, [cwd]: status }
      }));
    } finally {
      set((state) => {
        const statusFetchCount = Math.max(0, state.statusFetchCount - 1);
        return {
          statusFetchCount,
          isFetchingStatus: statusFetchCount > 0
        };
      });
    }
  },

  fetchDiff: async (cwd, path, staged) => {
    const key = diffKey(cwd, path, staged);
    try {
      const diff = await gitApi.getDiff(cwd, path, staged);
      set((state) => ({
        diffs: { ...state.diffs, [key]: diff }
      }));
    } catch (error) {
      console.error("Failed to fetch diff:", error);
      // Write an empty sentinel so the panel stops retrying on every render and
      // shows the "no diff available" state instead of an infinite spinner.
      set((state) => ({
        diffs: { ...state.diffs, [key]: "" }
      }));
      toast.error(`Failed to load diff: ${String(error)}`);
    }
  },

  stageFile: async (cwd, path) => {
    await gitApi.stage(cwd, path);
    invalidateFileDiffs(set, cwd, path);
    await get().refreshStatus(cwd);
  },

  unstageFile: async (cwd, path) => {
    await gitApi.unstage(cwd, path);
    invalidateFileDiffs(set, cwd, path);
    await get().refreshStatus(cwd);
  },

  discardFile: async (cwd, path) => {
    await gitApi.discard(cwd, path);
    invalidateFileDiffs(set, cwd, path);
    await get().refreshStatus(cwd);
  },
}));

/** Drop cached staged and unstaged diffs for a file after it mutates so the
 * panel refetches the now-current diff instead of showing a stale one. */
function invalidateFileDiffs(
  set: (fn: (state: GitStatusState) => Partial<GitStatusState>) => void,
  cwd: string,
  path: string,
) {
  set((state) => {
    const diffs = { ...state.diffs };
    delete diffs[diffKey(cwd, path, true)];
    delete diffs[diffKey(cwd, path, false)];
    return { diffs };
  });
}
