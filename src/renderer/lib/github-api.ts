/**
 * GitHub issues & PRs facade (spec-github-integration).
 *
 * Desktop invokes the `github_*` Tauri commands; web/remote and
 * `termul-server` POST the matching `/github/*` routes. Both return the
 * shared `IpcResult<T>` and never throw. The host runs `gh`, so the
 * phone client drives the same login as the desktop.
 */

import type {
  GithubCheckLog,
  GithubCheckLogRequest,
  GithubChecksRequest,
  GithubChecksResult,
  GithubContext,
  GithubItemDetail,
  GithubItemRequest,
  GithubListRequest,
  GithubListResult,
  GithubMergeRequest,
  GithubMergeResult
} from '@shared/types/github.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { postJson } from './ipc/http'
import { invokeIpc } from './ipc/tauri'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

async function call<T>(command: string, route: string, request: object): Promise<IpcResult<T>> {
  const result = isTauriContext()
    ? await invokeIpc<T>(command, { request })
    : await postJson<T>(route, request)
  if (!result.success) {
    void logFrontendError({
      level: 'warn',
      source: `github-api.${command}`,
      message: `${command} failed (code=${result.code})`
    })
  }
  return result
}

export const githubApi = {
  getContext(cwd: string): Promise<IpcResult<GithubContext>> {
    return call('github_get_context', '/github/context', { cwd })
  },

  listItems(request: GithubListRequest): Promise<IpcResult<GithubListResult>> {
    return call('github_list_items', '/github/items', request)
  },

  getItem(request: GithubItemRequest): Promise<IpcResult<GithubItemDetail>> {
    return call('github_get_item', '/github/item', request)
  },

  getChecks(request: GithubChecksRequest): Promise<IpcResult<GithubChecksResult>> {
    return call('github_get_checks', '/github/checks', request)
  },

  getCheckLog(request: GithubCheckLogRequest): Promise<IpcResult<GithubCheckLog>> {
    return call('github_get_check_log', '/github/check-log', request)
  },

  merge(request: GithubMergeRequest): Promise<IpcResult<GithubMergeResult>> {
    return call('github_merge', '/github/merge', request)
  }
}
