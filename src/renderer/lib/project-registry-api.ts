/**
 * Project registry commands — the one facade for changing the host's project
 * list, the same on every surface: the browser and the desktop both send
 * `add_project` / `update_project` / `remove_project` / `set_default_project`
 * over the `/ws` transport (the desktop through its Channel carrier).
 *
 * The host owns the list. These commands only ask; the new list comes back to
 * every device through the `projects` watch, so a command resolving does not
 * change any renderer store by itself.
 *
 * A remove, an archive or a root move that finds live chats or terminals bound
 * to the project is refused by the host (`project_busy`). That refusal surfaces here as a
 * {@link ProjectBusyError} carrying the bound entity ids. Nothing is stopped
 * until the caller resends the same command with `cascade: true` — the
 * renderer never closes a session or kills a terminal itself.
 */

import type { ProjectSummary } from '@shared/types/web-projects.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { AcpTransportError, getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'

/** The host refused to remove, archive or move a project that still has live chats or terminals. */
export class ProjectBusyError extends Error {
  readonly projectId: string
  /** Ids of the live sessions bound to the project. */
  readonly sessions: string[]
  /** Ids of the live terminals bound to the project. */
  readonly terminals: string[]

  constructor(projectId: string, sessions: string[], terminals: string[]) {
    super(`project ${projectId} has live sessions or terminals`)
    this.name = 'ProjectBusyError'
    this.projectId = projectId
    this.sessions = sessions
    this.terminals = terminals
  }
}

/** Options of the commands that can find a project busy. */
export interface CascadeOptions {
  /** Let the host stop the project's live sessions and terminals first. Only after the user agreed. */
  cascade?: boolean
}

/** A project to register. `id` is minted here (client-side) unless an existing id is kept. */
export interface NewRegistryProject {
  id?: string
  name: string
  path: string
  color: string
}

function toBusyError(error: unknown, projectId: string): ProjectBusyError | null {
  if (!(error instanceof AcpTransportError) || error.code !== WS_ERROR_CODES.PROJECT_BUSY) {
    return null
  }
  return new ProjectBusyError(
    projectId,
    error.details?.sessions ?? [],
    error.details?.terminals ?? []
  )
}

async function run<T>(operation: string, projectId: string, command: () => Promise<T>): Promise<T> {
  try {
    return await command()
  } catch (error) {
    const busy = toBusyError(error, projectId)
    if (busy) {
      void logFrontendError({
        level: 'info',
        source: `project-registry-api.${operation}`,
        message: `project ${projectId} is busy: ${busy.sessions.length} chat(s), ${busy.terminals.length} terminal(s)`
      })
      throw busy
    }
    void logFrontendError({
      level: 'warn',
      source: `project-registry-api.${operation}`,
      message: `${operation} for project ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    throw error
  }
}

export const projectRegistryApi = {
  /** Register a project. A repeat with the same id and fields is ok; a different path is refused `duplicate`. */
  add(project: NewRegistryProject): Promise<ProjectSummary> {
    const id = project.id ?? randomUUID()
    return run('add', id, () =>
      getAcpTransport().addProject({
        id,
        name: project.name,
        path: project.path,
        color: project.color
      })
    )
  },

  /**
   * Change a project's name, colour or root folder. Moving the root of a project
   * with live chats or terminals is refused (busy) unless `cascade` is set.
   */
  update(
    projectId: string,
    patch: { name?: string; color?: string; path?: string },
    options?: CascadeOptions
  ): Promise<void> {
    return run('update', projectId, () =>
      getAcpTransport().updateProject(projectId, {
        ...patch,
        ...(options?.cascade ? { cascade: true } : {})
      })
    )
  },

  /** Archive a project. A busy project is refused unless `cascade` is set. */
  archive(projectId: string, options?: CascadeOptions): Promise<void> {
    return run('archive', projectId, () =>
      getAcpTransport().updateProject(projectId, {
        isArchived: true,
        ...(options?.cascade ? { cascade: true } : {})
      })
    )
  },

  /** Bring an archived project back. */
  restore(projectId: string): Promise<void> {
    return run('restore', projectId, () =>
      getAcpTransport().updateProject(projectId, { isArchived: false })
    )
  },

  /** Remove a project (an unknown id is ok). A busy project is refused unless `cascade` is set. */
  remove(projectId: string, options?: CascadeOptions): Promise<void> {
    return run('remove', projectId, () =>
      getAcpTransport().removeProject(projectId, options?.cascade ? { cascade: true } : undefined)
    )
  },

  /** Make a project the host default: where a device with no choice of its own starts. */
  setDefault(projectId: string): Promise<void> {
    return run('setDefault', projectId, () => getAcpTransport().setDefaultProject(projectId))
  }
}
