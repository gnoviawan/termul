import { KEY_SCOPES, PersistenceKeys, scopedKey, scopeOf } from '@shared/types/persistence.types'
import { describe, expect, it, vi } from 'vitest'
import { PINNED_COMMANDS_KEY } from '@/hooks/use-pinned-commands'
import { RECENT_COMMANDS_KEY } from '@/hooks/use-recent-commands'
import {
  APP_SETTINGS_KEY,
  CONTEXT_BAR_SETTINGS_KEY,
  KEYBOARD_SHORTCUTS_KEY,
  TOC_SETTINGS_KEY
} from '@/types/settings'
import { ACP_AGENTS_KEY } from '../acp-agents-persistence'
import { ACP_AUTH_METHODS_KEY } from '../acp-auth-method-memory'
import { ACP_MCP_KEY } from '../acp-mcp-persistence'

vi.mock('@/lib/api', () => ({ persistenceApi: {} }))

describe('scopeOf', () => {
  it('classifies every shared-lww key from the spec table', () => {
    for (const key of [
      'settings/app',
      'settings/keyboard-shortcuts',
      'settings/context-bar',
      'settings/toc',
      'settings/pinned-commands',
      'agents/custom',
      'acp/agents',
      'acp/auth-methods',
      'acp/mcp-servers'
    ]) {
      expect(scopeOf(key), key).toBe('sharedLww')
    }
    expect([...KEY_SCOPES.sharedLww]).toHaveLength(9)
  })

  it('classifies ssh/profiles as shared-cas', () => {
    expect(scopeOf('ssh/profiles')).toBe('sharedCas')
    expect([...KEY_SCOPES.sharedCas]).toEqual(['ssh/profiles'])
  })

  it('keeps every other key family device-scoped', () => {
    const deviceKeys = [
      PersistenceKeys.shellLayout,
      PersistenceKeys.windowState,
      PersistenceKeys.activeProject,
      PersistenceKeys.projects,
      PersistenceKeys.terminals('p1'),
      PersistenceKeys.snapshots('p1'),
      PersistenceKeys.workspace('p1'),
      PersistenceKeys.lastSelectedAgent,
      PersistenceKeys.lastComposerOptions('c1'),
      PersistenceKeys.agentModelCatalog('c1'),
      PersistenceKeys.mobileFileExplorerFolder('p1'),
      'editor-state/p1',
      'last-launch-draft/p1',
      'chat-draft/p1/s1',
      'settings/recent-commands',
      'projects/p1/command-history',
      'acp/mention-recents/p1',
      'sessions/auto-save',
      'project-prefs'
    ]
    for (const key of deviceKeys) expect(scopeOf(key), key).toBe('device')
  })

  it('agrees with the constants the renderer actually persists under', () => {
    expect(scopeOf(APP_SETTINGS_KEY)).toBe('sharedLww')
    expect(scopeOf(KEYBOARD_SHORTCUTS_KEY)).toBe('sharedLww')
    expect(scopeOf(CONTEXT_BAR_SETTINGS_KEY)).toBe('sharedLww')
    expect(scopeOf(TOC_SETTINGS_KEY)).toBe('sharedLww')
    expect(scopeOf(PINNED_COMMANDS_KEY)).toBe('sharedLww')
    expect(scopeOf(PersistenceKeys.customAgents)).toBe('sharedLww')
    expect(scopeOf(ACP_AGENTS_KEY)).toBe('sharedLww')
    expect(scopeOf(ACP_AUTH_METHODS_KEY)).toBe('sharedLww')
    expect(scopeOf(ACP_MCP_KEY)).toBe('sharedLww')
    expect(scopeOf(RECENT_COMMANDS_KEY)).toBe('device')
  })

  it('does not treat a key that merely starts like a shared key as shared', () => {
    expect(scopeOf('settings/app/extra')).toBe('device')
    expect(scopeOf('ssh/profiles/p1')).toBe('device')
    expect(scopeOf('acp/agents-cache')).toBe('device')
  })
})

describe('scopedKey', () => {
  it('prefixes device keys with the device partition', () => {
    expect(scopedKey('shell-layout', 'dev-1')).toBe('device/dev-1/shell-layout')
    expect(scopedKey(PersistenceKeys.terminals('p1'), 'dev-1')).toBe('device/dev-1/terminals/p1')
    expect(scopedKey(PersistenceKeys.workspace('p1'), 'dev-1')).toBe('device/dev-1/workspace/p1')
    expect(scopedKey(PersistenceKeys.activeProject, 'dev-1')).toBe('device/dev-1/active-project')
  })

  it('puts shared keys in the shared namespaces regardless of device', () => {
    expect(scopedKey('settings/app', 'dev-1')).toBe('shared/lww/settings/app')
    expect(scopedKey('settings/app', 'dev-2')).toBe('shared/lww/settings/app')
    expect(scopedKey('ssh/profiles', 'dev-1')).toBe('shared/cas/ssh/profiles')
  })
})
