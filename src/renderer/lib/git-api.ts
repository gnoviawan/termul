import { invoke } from "@tauri-apps/api/core";
import { GitStatusDetail } from "@shared/types/ipc.types";

export const gitApi = {
  getStatus: (cwd: string) => 
    invoke<GitStatusDetail[]>("git_get_status", { cwd }),
    
  getDiff: (cwd: string, path: string) => 
    invoke<string>("git_get_diff", { cwd, path }),
};
