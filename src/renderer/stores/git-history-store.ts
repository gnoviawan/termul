import { create } from "zustand";
import { toast } from "sonner";
import { gitApi } from "@/lib/git-api";
import type { GitCommit } from "@shared/types/ipc.types";

export interface GitHistoryState {
  // commits[cwd] = GitCommit[] (newest first)
  commits: Record<string, GitCommit[]>;
  // loading[cwd] = boolean
  loading: Record<string, boolean>;
  // error[cwd] = string | null
  error: Record<string, string | null>;

  refreshLog: (cwd: string, limit?: number) => Promise<void>;
}

export const useGitHistoryStore = create<GitHistoryState>((set) => ({
  commits: {},
  loading: {},
  error: {},

  refreshLog: async (cwd, limit) => {
    // Capture a per-cwd request token before awaiting so a later refresh that
    // resolves first cannot be overwritten by an earlier, slower response.
    const token = (logRequestVersions[cwd] ?? 0) + 1;
    logRequestVersions[cwd] = token;
    const isCurrent = () => logRequestVersions[cwd] === token;

    set((state) => ({
      loading: { ...state.loading, [cwd]: true },
      error: { ...state.error, [cwd]: null },
    }));

    try {
      const commits = await gitApi.getLog(cwd, limit);
      if (!isCurrent()) return;
      set((state) => ({
        commits: { ...state.commits, [cwd]: commits },
        loading: { ...state.loading, [cwd]: false },
      }));
    } catch (err) {
      if (!isCurrent()) return;
      const message = String(err);
      set((state) => ({
        // Keep any previously-loaded commits so a transient refresh failure
        // does not wipe the displayed history; only surface the error.
        loading: { ...state.loading, [cwd]: false },
        error: { ...state.error, [cwd]: message },
      }));
      toast.error(`Failed to load git history: ${message}`);
    }
  },
}));

/** Monotonic request token per cwd, kept outside React state because it is
 * control metadata for discarding superseded in-flight fetches. */
const logRequestVersions: Record<string, number> = {};
