/**
 * Project Registry Service
 *
 * Maintains a mapping of projectId → projectPath for use by all IPC handlers
 * in the main process. This enables proper project-scoped operations.
 *
 * Projects must be registered via IPC before any merge/worktree operations.
 */

export class ProjectRegistry {
  private projects: Map<string, string> = new Map()

  /**
   * Register a project with its filesystem path
   * @param id - Unique project identifier
   * @param path - Absolute path to the git repository root
   */
  register(id: string, path: string): void {
    this.projects.set(id, path)
  }

  /**
   * Get the filesystem path for a project
   * @param id - Project identifier
   * @returns Project path, or null if not found
   */
  get(id: string): string | null {
    return this.projects.get(id) || null
  }

  /**
   * Check if a project is registered
   * @param id - Project identifier
   * @returns True if project exists in registry
   */
  has(id: string): boolean {
    return this.projects.has(id)
  }

  /**
   * Remove a project from the registry
   * @param id - Project identifier
   */
  unregister(id: string): void {
    this.projects.delete(id)
  }

  /**
   * Clear all registered projects (useful for testing)
   */
  clear(): void {
    this.projects.clear()
  }
}

// Singleton instance for use across all IPC handlers
export const projectRegistry = new ProjectRegistry()
