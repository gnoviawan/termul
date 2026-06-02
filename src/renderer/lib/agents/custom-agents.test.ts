/**
 * Unit tests for custom-agent CRUD + merge logic (ADR-004.3 / ADR-004.6).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRead, mockWrite } = vi.hoisted(() => ({
	mockRead: vi.fn(),
	mockWrite: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
	persistenceApi: {
		read: mockRead,
		write: mockWrite,
	},
}))

import {
	deleteCustomAgent,
	getAgentById,
	loadAllAgents,
	loadCustomAgents,
	mergeAgents,
	toAgentDefinition,
	upsertCustomAgent,
	validateCustomAgent,
	type CustomAgentInput,
} from '@/lib/agents/custom-agents'
import { BUILT_IN_AGENTS, type TerminalAgentDefinition } from '@/lib/agents/agent-registry'

const validInput: CustomAgentInput = {
	name: 'My Agent',
	command: 'myagent',
	promptMode: 'positional',
}

describe('validateCustomAgent', () => {
	it('accepts a valid positional agent', () => {
		expect(validateCustomAgent(validInput)).toBeNull()
	})

	it('rejects empty name and command', () => {
		expect(validateCustomAgent({ ...validInput, name: '  ' })).toMatch(/name/i)
		expect(validateCustomAgent({ ...validInput, command: '' })).toMatch(/command/i)
	})

	it('requires a promptFlag when promptMode is flag', () => {
		expect(validateCustomAgent({ ...validInput, promptMode: 'flag' })).toMatch(/flag/i)
		expect(
			validateCustomAgent({ ...validInput, promptMode: 'flag', promptFlag: '-i' }),
		).toBeNull()
	})

	it('rejects an invalid prompt mode', () => {
		expect(
			validateCustomAgent({ ...validInput, promptMode: 'bogus' as never }),
		).toMatch(/prompt mode/i)
	})
})

describe('toAgentDefinition', () => {
	it('marks the agent as not built-in and generates an id', () => {
		const def = toAgentDefinition(validInput)
		expect(def.isBuiltIn).toBe(false)
		expect(def.id).toMatch(/^custom-/)
		expect(def.command).toBe('myagent')
		expect(def.baseArgs).toEqual([])
	})

	it('keeps a provided id (update path)', () => {
		const def = toAgentDefinition({ ...validInput, id: 'custom-fixed' })
		expect(def.id).toBe('custom-fixed')
	})

	it('only retains promptFlag for flag mode', () => {
		const positional = toAgentDefinition({ ...validInput, promptFlag: '-x' })
		expect(positional.promptFlag).toBeUndefined()
		const flag = toAgentDefinition({ ...validInput, promptMode: 'flag', promptFlag: '-x' })
		expect(flag.promptFlag).toBe('-x')
	})
})

describe('mergeAgents', () => {
	it('keeps built-ins first and appends custom agents', () => {
		const custom: TerminalAgentDefinition = toAgentDefinition({
			...validInput,
			id: 'custom-1',
		})
		const merged = mergeAgents([custom])
		expect(merged.slice(0, BUILT_IN_AGENTS.length)).toEqual(BUILT_IN_AGENTS)
		expect(merged.at(-1)?.id).toBe('custom-1')
	})

	it('drops custom agents that collide with a built-in id (built-ins win)', () => {
		const shadow: TerminalAgentDefinition = {
			...toAgentDefinition(validInput),
			id: 'claude-code',
			command: 'evil',
		}
		const merged = mergeAgents([shadow])
		const claude = merged.find((a) => a.id === 'claude-code')
		expect(claude?.command).toBe('claude')
		expect(merged.filter((a) => a.id === 'claude-code')).toHaveLength(1)
	})
})

describe('persistence flows', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockWrite.mockResolvedValue({ success: true, data: undefined })
	})

	it('loadCustomAgents returns [] when nothing persisted', async () => {
		mockRead.mockResolvedValue({ success: false, code: 'FILE_NOT_FOUND', error: 'x' })
		expect(await loadCustomAgents()).toEqual([])
	})

	it('loadCustomAgents forces isBuiltIn:false on load', async () => {
		mockRead.mockResolvedValue({
			success: true,
			data: { agents: [{ ...toAgentDefinition(validInput), isBuiltIn: true }] },
		})
		const loaded = await loadCustomAgents()
		expect(loaded[0].isBuiltIn).toBe(false)
	})

	it('getAgentById resolves custom agents after loadCustomAgents', async () => {
		const icon = '<svg viewBox="0 0 16 16"><circle /></svg>'
		mockRead.mockResolvedValue({
			success: true,
			data: {
				agents: [toAgentDefinition({ ...validInput, id: 'custom-1', icon })],
			},
		})
		await loadCustomAgents()
		expect(getAgentById('custom-1')?.icon).toBe(icon)
		expect(getAgentById('claude-code')?.command).toBe('claude')
	})

	it('upsertCustomAgent validates then writes', async () => {
		mockRead.mockResolvedValue({ success: false, code: 'FILE_NOT_FOUND', error: 'x' })
		const def = await upsertCustomAgent(validInput)
		expect(def.name).toBe('My Agent')
		expect(mockWrite).toHaveBeenCalledOnce()
		const [, payload] = mockWrite.mock.calls[0]
		expect(payload.agents).toHaveLength(1)
	})

	it('upsertCustomAgent throws on invalid input and does not write', async () => {
		await expect(upsertCustomAgent({ ...validInput, command: '' })).rejects.toThrow()
		expect(mockWrite).not.toHaveBeenCalled()
	})

	it('upsertCustomAgent replaces an existing agent with the same id', async () => {
		mockRead.mockResolvedValue({
			success: true,
			data: { agents: [toAgentDefinition({ ...validInput, id: 'custom-1', name: 'Old' })] },
		})
		await upsertCustomAgent({ ...validInput, id: 'custom-1', name: 'New' })
		const [, payload] = mockWrite.mock.calls[0]
		expect(payload.agents).toHaveLength(1)
		expect(payload.agents[0].name).toBe('New')
	})

	it('deleteCustomAgent removes by id and persists', async () => {
		mockRead.mockResolvedValue({
			success: true,
			data: { agents: [toAgentDefinition({ ...validInput, id: 'custom-1' })] },
		})
		await deleteCustomAgent('custom-1')
		const [, payload] = mockWrite.mock.calls[0]
		expect(payload.agents).toHaveLength(0)
	})

	it('deleteCustomAgent is a no-op for unknown ids', async () => {
		mockRead.mockResolvedValue({ success: true, data: { agents: [] } })
		await deleteCustomAgent('nope')
		expect(mockWrite).not.toHaveBeenCalled()
	})

	it('loadAllAgents merges persisted custom agents with built-ins', async () => {
		mockRead.mockResolvedValue({
			success: true,
			data: { agents: [toAgentDefinition({ ...validInput, id: 'custom-9' })] },
		})
		const all = await loadAllAgents()
		expect(all.length).toBe(BUILT_IN_AGENTS.length + 1)
		expect(all.at(-1)?.id).toBe('custom-9')
	})
})
