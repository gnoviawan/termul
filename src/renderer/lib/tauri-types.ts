/** Shell types matching Rust commands in src-tauri/src/lib.rs */
export interface ShellInfo {
  name: string
  path: string
  args?: string[]
}

export interface DetectedShells {
  shells: ShellInfo[]
  defaultShell: ShellInfo
}
