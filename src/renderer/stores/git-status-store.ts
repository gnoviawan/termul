import { create } from "zustand";
import { gitApi } from "@/lib/api";
import { GitStatusDetail } from "@shared/types/ipc.types";

export interface GitStatusState {
  // statuses[cwd] = GitStatusDetail[]
  statuses: Record<string, GitStatusDetail[]>;
  // diffs["cwd:path"] = string
  diffs: Record<string, string>;
  selectedFile: string | null;
  isFetchingStatus: boolean;
  
  setSelectedFile: (path: string | null) => void;
  refreshStatus: (cwd: string) => Promise<void>;
  fetchDiff: (cwd: string, path: string) => Promise<void>;
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  statuses: {},
  diffs: {},
  selectedFile: null,
  isFetchingStatus: false,

  setSelectedFile: (path) => set({ selectedFile: path }),

  refreshStatus: async (cwd) => {
    set({ isFetchingStatus: true });
    try {
      const status = await gitApi.getStatus(cwd);
      set((state) => ({
        statuses: { ...state.statuses, [cwd]: status }
      }));
    } finally {
      set({ isFetchingStatus: false });
    }
  },

  fetchDiff: async (cwd, path) => {
    const diffKey = `${cwd}:${path}`;
    try {
      const diff = await gitApi.getDiff(cwd, path);
      set((state) => ({
        diffs: { ...state.diffs, [diffKey]: diff }
      }));
    } catch (error) {
      console.error("Failed to fetch diff:", error);
    }
  },
}));
