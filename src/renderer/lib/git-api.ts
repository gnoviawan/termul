import { invoke } from "@tauri-apps/api/core";
import { GitCommit, GitStatusDetail } from "@shared/types/ipc.types";

export const gitApi = {
  getStatus: (cwd: string) =>
    invoke<GitStatusDetail[]>("git_get_status", { cwd }),

  getDiff: (cwd: string, path: string, staged = false) =>
    invoke<string>("git_get_diff", { cwd, path, staged }),

  stage: (cwd: string, path: string) =>
    invoke<void>("git_stage", { cwd, path }),

  unstage: (cwd: string, path: string) =>
    invoke<void>("git_unstage", { cwd, path }),

  discard: (cwd: string, path: string) =>
    invoke<void>("git_discard", { cwd, path }),

  getLog: (cwd: string, limit?: number) =>
    invoke<GitCommit[]>("git_get_log", { cwd, limit }),
};
