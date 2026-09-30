/**
 * Fake-agent registration through the app's own persistence path (CAP-1).
 *
 * The app persists custom ACP agents via the plugin-store IPC under the key
 * `acp/agents` in `termul-data.json`, wrapped as `{_version: 1, data: [...]}`.
 * Rather than mutating the store file behind the app's back, we register
 * through the app's own IPC surface after attach:
 *
 *  1. `plugin:store|load` the app's data store (same file the renderer's
 *     `persistenceApi` uses — `Store.load('termul-data.json')`).
 *  2. Read the current list under `acp/agents`, upsert our config
 *     (id 'custom-perf0001', configId 'custom-perfstub' — non-empty,
 *     satisfying the Rust `require_config_id`).
 *  3. `plugin:store|set` + `plugin:store|save` (the app's own
 *     versioned-wrapper format stays intact).
 *  4. Reload the renderer page so its store bootstrap (`loadAgentConfigs`)
 *     picks the entry up in the same run.
 *
 * All IPC goes through `window.__TAURI_INTERNALS__.invoke` (withGlobalTauri);
 * command names/shapes mirror the plugin-store JS API exactly.
 */

import path from 'node:path'
import type { AppHandle } from './launch.ts'

export interface StoredAgentConfig {
  id: string
  configId?: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  allowTerminal?: boolean
  templateId?: string
}

export const ACP_AGENTS_KEY = 'acp/agents'
export const PERF_AGENT_CONFIG_ID = 'custom-perfstub'
export const PERF_AGENT_STORE_ID = 'custom-perf0001'

/** Absolute path of the fake-agent entry script (spawned via `bun`). */
export function fakeAgentScriptPath(repoRoot: string): string {
  return path.join(repoRoot, 'tools', 'perf', 'fake-agent', 'fake-agent.ts')
}

/**
 * Build the StoredAgentConfig the app will persist + spawn. Env carries the
 * scenario knobs because the ACP spawn path passes config.env to the child.
 */
export function buildFakeAgentConfig(
  repoRoot: string,
  env: Record<string, string>
): StoredAgentConfig {
  const script = fakeAgentScriptPath(repoRoot)
  return {
    id: PERF_AGENT_STORE_ID,
    configId: PERF_AGENT_CONFIG_ID,
    name: 'Perf Stub Agent',
    command: 'bun',
    args: [script],
    env,
    allowTerminal: false
  }
}

/**
 * Register the fake agent in the running app. Idempotent: an existing entry
 * with our store id is replaced (identity fields win). Mirrors what
 * `saveAgentConfigs` writes — the versioned wrapper, the exact key, and the
 * config shape the app's `loadAgentConfigs` normalization accepts.
 */
export async function registerFakeAgent(
  handle: AppHandle,
  config: StoredAgentConfig
): Promise<void> {
  const script = `
    (async () => {
      const internals = window.__TAURI_INTERNALS__
      if (!internals) throw new Error('withGlobalTauri off: no __TAURI_INTERNALS__')
      const rid = await internals.invoke('plugin:store|load', {
        path: 'termul-data.json',
        options: { autoSave: false }
      })
      try {
        // plugin:store|get returns [value, exists]
        const [entry, exists] = await internals.invoke('plugin:store|get', {
          rid,
          key: ${JSON.stringify(ACP_AGENTS_KEY)}
        })
        let list = []
        if (exists && entry != null && typeof entry === 'object' && Array.isArray(entry.data)) {
          list = entry.data
        }
        const cfg = ${JSON.stringify(config)}
        const idx = list.findIndex((c) => c && c.id === cfg.id)
        if (idx === -1) list = [...list, cfg]
        else list = list.map((c) => (c && c.id === cfg.id ? cfg : c))
        const versioned = { _version: 1, data: list }
        await internals.invoke('plugin:store|set', {
          rid,
          key: ${JSON.stringify(ACP_AGENTS_KEY)},
          value: versioned
        })
        await internals.invoke('plugin:store|save', { rid })
      } finally {
        await internals.invoke('plugin:store|close', { rid }).catch(() => {})
      }
      return 'ok'
    })()
  `
  const result = await handle.evaluate<string>(script)
  if (result !== 'ok') {
    throw new Error(`fake-agent registration failed: ${String(result)}`)
  }
}

/**
 * Seed one project into the app's persistence store and reload so the boot
 * sequence selects it (`setProjects` activates `projects[0]`). Fresh scratch
 * profiles have zero projects, which leaves the workspace empty and the
 * launcher composer mounted-but-hidden — stream-storm needs a selected
 * project before it can drive the launcher UI. Same `termul-data.json`
 * plugin-store IPC as `registerFakeAgent` uses; key `projects`, same
 * versioned wrapper.
 */
export async function seedPerfProject(handle: AppHandle, projectPath: string): Promise<void> {
  const id = 'perf-project-0001'
  const data = {
    projects: [
      {
        id,
        name: 'perf-project',
        color: 'blue',
        path: projectPath,
        isArchived: false
      }
    ],
    groups: [],
    activeProjectId: id,
    updatedAt: new Date().toISOString()
  }
  const script = `
    (async () => {
      const internals = window.__TAURI_INTERNALS__
      if (!internals) throw new Error('withGlobalTauri off: no __TAURI_INTERNALS__')
      const rid = await internals.invoke('plugin:store|load', {
        path: 'termul-data.json',
        options: { autoSave: false }
      })
      try {
        await internals.invoke('plugin:store|set', {
          rid,
          key: 'projects',
          value: { _version: 1, data: ${JSON.stringify(data)} }
        })
        await internals.invoke('plugin:store|save', { rid })
      } finally {
        await internals.invoke('plugin:store|close', { rid }).catch(() => {})
      }
      return 'ok'
    })()
  `
  const result = await handle.evaluate<string>(script)
  if (result !== 'ok') {
    throw new Error(`perf-project seed failed: ${String(result)}`)
  }
}

/**
 * Reload the renderer so its startup bootstrap (`loadAgentConfigs`) sees the
 * just-written config in the same run. Cheap, deterministic, and it also
 * re-runs the metric init scripts (installed on every new document).
 */
export async function reloadRenderer(handle: AppHandle): Promise<void> {
  const page = await handle.page()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('load').catch(() => undefined)
}
