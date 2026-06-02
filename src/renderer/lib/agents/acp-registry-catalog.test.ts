/**
 * Unit tests for the ACP Registry catalog wrapper (ADR-004.6).
 *
 * The registry supplies IDENTITY ONLY. These tests pin that the launch command
 * is never derived from the registry and that identity is applied via registryId.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockIsTauri: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mockInvoke,
}))

vi.mock('@/lib/tauri-runtime', () => ({
	isTauriContext: mockIsTauri,
}))

import {
	applyRegistryIdentity,
	fetchAcpRegistry,
	indexByRegistryId,
	type AcpRegistryCatalog,
} from '@/lib/agents/acp-registry-catalog'
import type { TerminalAgentDefinition } from '@/lib/agents/agent-registry'

const catalog: AcpRegistryCatalog = {
	source: 'network',
	fetchedAt: '2026-06-01T00:00:00Z',
	entries: [
		{ id: 'claude-acp', name: 'Claude Code', icon: 'https://cdn/claude.svg' },
		{ id: 'gemini', name: 'Gemini', icon: 'https://cdn/gemini.svg' },
	],
}

const claudeDef: TerminalAgentDefinition = {
	id: 'claude-code',
	name: 'Claude Code',
	command: 'claude',
	baseArgs: [],
	promptMode: 'positional',
	registryId: 'claude-acp',
	icon: 'bundled/claude-code.svg',
	isBuiltIn: true,
}

describe('fetchAcpRegistry', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns an empty catalog outside Tauri without invoking', async () => {
		mockIsTauri.mockReturnValue(false)
		const result = await fetchAcpRegistry()
		expect(result.source).toBe('empty')
		expect(result.entries).toEqual([])
		expect(mockInvoke).not.toHaveBeenCalled()
	})

	it('returns catalog data on success', async () => {
		mockIsTauri.mockReturnValue(true)
		mockInvoke.mockResolvedValue({ success: true, data: catalog })
		const result = await fetchAcpRegistry(true)
		expect(result.source).toBe('network')
		expect(result.entries).toHaveLength(2)
		expect(mockInvoke).toHaveBeenCalledWith('agent_registry_fetch', { forceRefresh: true })
	})

	it('falls back to empty on IpcResult error', async () => {
		mockIsTauri.mockReturnValue(true)
		mockInvoke.mockResolvedValue({ success: false, error: 'boom', code: 'X' })
		expect((await fetchAcpRegistry()).source).toBe('empty')
	})

	it('falls back to empty when invoke throws', async () => {
		mockIsTauri.mockReturnValue(true)
		mockInvoke.mockRejectedValue(new Error('network down'))
		expect((await fetchAcpRegistry()).source).toBe('empty')
	})
})

describe('applyRegistryIdentity', () => {
	it('keeps an existing bundled icon (does not overwrite from remote registry)', () => {
		const index = indexByRegistryId(catalog)
		const withIcon = { ...claudeDef, icon: 'bundled.svg' }
		const out = applyRegistryIdentity(withIcon, index)
		expect(out.icon).toBe('bundled.svg')
		// We never silently swap a bundled icon for a remote URL.
		const entry = index.get(withIcon.registryId!)
		expect(out.icon).not.toBe(entry?.icon)
	})

	it('returns the def unchanged when registryId is absent or unmatched', () => {
		const index = indexByRegistryId(catalog)
		const noReg = { ...claudeDef, registryId: undefined, icon: 'x' }
		expect(applyRegistryIdentity(noReg, index)).toBe(noReg)
		const unmatched = { ...claudeDef, registryId: 'does-not-exist', icon: 'x' }
		expect(applyRegistryIdentity(unmatched, index)).toBe(unmatched)
	})

	it('never injects a launch command from registry data', () => {
		const index = indexByRegistryId(catalog)
		const out = applyRegistryIdentity({ ...claudeDef, icon: 'x' }, index)
		// Identity application only touches the icon; command/args/mode are intact.
		expect(out.command).toBe('claude')
		expect(out.baseArgs).toEqual([])
		expect(out.promptMode).toBe('positional')
		// No `distribution` (the ACP invocation) leaks into the definition shape.
		expect(out).not.toHaveProperty('distribution')
	})

	it('refuses to inject a remote icon into a def with no bundled icon (offline by default)', () => {
		const index = indexByRegistryId(catalog)
		const bundleless: TerminalAgentDefinition = {
			id: 'claude-code',
			name: 'Claude Code',
			command: 'claude',
			baseArgs: [],
			promptMode: 'positional',
			registryId: 'claude-acp',
			isBuiltIn: true,
		}
		const out = applyRegistryIdentity(bundleless, index)
		// Critically: the registry's remote icon URL is NOT used. The default
		// experience stays offline — no silent network fetch on every render.
		expect(out.icon).toBeUndefined()
	})
})
