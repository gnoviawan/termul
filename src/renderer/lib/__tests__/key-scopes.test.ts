import {
  KEY_SCOPES,
  type KeyScope,
  PersistenceKeys,
  scopedKey,
  scopeOf
} from '@shared/types/persistence.types'
import { describe, expect, it } from 'vitest'

/**
 * The scope every `PersistenceKeys` entry must resolve to. A new entry needs a
 * row here (the type forces it) and, when it is shared between devices, a line
 * in `KEY_SCOPES` (the test below forces that).
 */
const DECLARED_SCOPES: Record<keyof typeof PersistenceKeys, KeyScope> = {
  terminals: 'device',
  snapshots: 'device',
  projectPrefs: 'device',
  windowState: 'device',
  appSettings: 'sharedLww',
  keyboardShortcuts: 'sharedLww',
  contextBarSettings: 'sharedLww',
  tocSettings: 'sharedLww',
  pinnedCommands: 'sharedLww',
  recentCommands: 'device',
  commandHistory: 'device',
  lastLaunchDraft: 'device',
  chatDraft: 'device',
  acpAgents: 'sharedLww',
  acpAuthMethods: 'sharedLww',
  acpMcpServers: 'sharedLww',
  acpMentionRecentsLegacy: 'device',
  acpMentionRecents: 'device',
  sshProfiles: 'sharedCas',
  sessionsAutoSave: 'device',
  sessionsLegacyMigrated: 'device',
  customAgents: 'sharedLww',
  lastSelectedAgent: 'device',
  lastComposerOptions: 'device',
  agentModelCatalog: 'device',
  agentRejectedOptionValues: 'device',
  mobileFileExplorerFolder: 'device',
  activeProject: 'device',
  workspace: 'device',
  shellLayout: 'device'
}

/** The logical key an entry stands for; parametrized entries get sample ids. */
function resolve(entry: string | ((...args: string[]) => string)): string {
  return typeof entry === 'function' ? entry('p1', 's1') : entry
}

const entries = Object.entries(PersistenceKeys) as [
  keyof typeof PersistenceKeys,
  string | ((...args: string[]) => string)
][]

describe('PersistenceKeys', () => {
  it('declares a scope for every entry and no scope for a missing entry', () => {
    expect(entries.map(([name]) => name).sort()).toEqual(Object.keys(DECLARED_SCOPES).sort())
  })

  it('resolves every entry to its declared scope', () => {
    for (const [name, entry] of entries) {
      expect(scopeOf(resolve(entry)), name).toBe(DECLARED_SCOPES[name])
    }
  })

  it('gives every entry a distinct key', () => {
    const keys = entries.map(([, entry]) => resolve(entry))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('builds parametrized keys from every argument', () => {
    expect(PersistenceKeys.chatDraft('p1', 's1')).toBe('chat-draft/p1/s1')
    expect(PersistenceKeys.commandHistory('p1')).toBe('projects/p1/command-history')
    expect(PersistenceKeys.lastLaunchDraft('p1')).toBe('last-launch-draft/p1')
    expect(PersistenceKeys.acpMentionRecents('p1%00%2Fwork')).toBe(
      'acp/mention-recents/p1%00%2Fwork'
    )
  })

  it('keeps every shared row of KEY_SCOPES backed by a PersistenceKeys entry', () => {
    const declared = new Set(entries.map(([, entry]) => resolve(entry)))
    for (const key of [...KEY_SCOPES.sharedLww, ...KEY_SCOPES.sharedCas]) {
      expect(declared.has(key), key).toBe(true)
    }
  })
})

describe('scopeOf', () => {
  it('classifies every shared-lww key', () => {
    for (const key of KEY_SCOPES.sharedLww) expect(scopeOf(key), key).toBe('sharedLww')
    expect([...KEY_SCOPES.sharedLww]).toHaveLength(9)
  })

  it('classifies ssh/profiles as shared-cas', () => {
    expect(scopeOf('ssh/profiles')).toBe('sharedCas')
    expect([...KEY_SCOPES.sharedCas]).toEqual(['ssh/profiles'])
  })

  it('keeps keys outside the table device-scoped', () => {
    for (const key of ['editor-state/p1', 'project-prefs', 'anything/else']) {
      expect(scopeOf(key), key).toBe('device')
    }
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
