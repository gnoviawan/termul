import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { signInCodexAccount } from './codex-account-sign-in'

const { api, authenticateAgent, killAgent } = vi.hoisted(() => ({
  api: { startLogin: vi.fn() },
  authenticateAgent: vi.fn(),
  killAgent: vi.fn()
}))

vi.mock('@/lib/codex-accounts-api', () => ({ codexAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  authenticateAgent.mockResolvedValue(true)
  killAgent.mockResolvedValue(undefined)
  api.startLogin.mockResolvedValue({
    agentId: 'agent-sign-in',
    capabilities: {},
    authMethods: [
      { id: 'chat-gpt', name: 'ChatGPT' },
      { id: 'chat-gpt-device-code', name: 'Device code' }
    ]
  })
  useAcpStore.setState({
    ...FRESH,
    agentConfigs: [
      {
        id: 'acp-registry:codex-acp',
        name: 'Codex',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp'],
        env: { OPENAI_API_KEY: 'sk-test' }
      }
    ],
    authenticateAgent,
    killAgent
  } as never)
})

describe('signInCodexAccount', () => {
  it('spawns with the Codex config, authenticates ChatGPT, then stops the agent', async () => {
    await signInCodexAccount('ab12', 'chat-gpt')
    expect(api.startLogin).toHaveBeenCalledWith(
      'ab12',
      expect.objectContaining({
        configId: 'acp-registry:codex-acp',
        command: 'npx'
      })
    )
    expect(authenticateAgent).toHaveBeenCalledWith('agent-sign-in', 'chat-gpt')
    expect(killAgent).toHaveBeenCalledWith('agent-sign-in')
  })

  it('refuses an API-key method and does not spawn', async () => {
    await expect(signInCodexAccount('ab12', 'api-key')).rejects.toThrow(/ChatGPT only/)
    expect(api.startLogin).not.toHaveBeenCalled()
  })

  it('stops the agent when authenticate fails', async () => {
    authenticateAgent.mockRejectedValue(new Error('cancelled'))
    await expect(signInCodexAccount('ab12', 'chat-gpt-device-code')).rejects.toThrow('cancelled')
    expect(killAgent).toHaveBeenCalledWith('agent-sign-in')
  })
})
