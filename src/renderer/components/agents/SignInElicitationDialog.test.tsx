import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOpenUrl, mockRespondAgentSignIn, mockClearPendingSignIn } = vi.hoisted(() => ({
  mockOpenUrl: vi.fn(async () => ({ success: true as const, data: undefined })),
  mockRespondAgentSignIn: vi.fn(async () => {}),
  mockClearPendingSignIn: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/lib/api', () => ({
  openerApi: { openUrlWithSystemBrowser: mockOpenUrl }
}))

vi.mock('@/stores/acp-store', () => {
  const state = {
    respondAgentSignIn: mockRespondAgentSignIn,
    clearPendingSignIn: mockClearPendingSignIn
  }
  return {
    useAcpStore: (sel: (s: typeof state) => unknown) => sel(state)
  }
})

import { SignInElicitationDialog, splitSignInCode } from './SignInElicitationDialog'

const DEVICE_URL = 'https://auth.openai.com/codex/device'

function renderDialog(message = 'Sign in to ChatGPT and enter this code: ABCD-12345') {
  return render(
    <SignInElicitationDialog
      agentId="agent-1"
      agentName="Codex"
      url={DEVICE_URL}
      message={message}
    />
  )
}

describe('splitSignInCode', () => {
  it('splits a trailing device code off the message', () => {
    expect(splitSignInCode('Sign in to ChatGPT and enter this code: ABCD-12345')).toEqual({
      text: 'Sign in to ChatGPT and enter this code',
      code: 'ABCD-12345'
    })
  })

  it('leaves a message without a code-shaped tail whole', () => {
    expect(splitSignInCode('Sign in to continue')).toBeNull()
    expect(splitSignInCode('Status: OK')).toBeNull()
  })
})

describe('SignInElicitationDialog', () => {
  beforeEach(() => {
    mockOpenUrl.mockClear()
    mockRespondAgentSignIn.mockClear()
    mockClearPendingSignIn.mockClear()
  })
  afterEach(cleanup)

  it('shows the code on its own and the instruction from the agent', () => {
    renderDialog()
    expect(screen.getByText('Sign in to Codex')).toBeTruthy()
    expect(screen.getByLabelText('Sign-in code').textContent).toBe('ABCD-12345')
    expect(screen.getByText('Sign in to ChatGPT and enter this code')).toBeTruthy()
    expect(screen.getByText(DEVICE_URL)).toBeTruthy()
  })

  it('shows a message without a code whole', () => {
    renderDialog('Sign in to continue')
    expect(screen.getByText('Sign in to continue')).toBeTruthy()
    expect(screen.queryByLabelText('Sign-in code')).toBeNull()
  })

  it('opens the page and accepts once, keeping the dialog for the code', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    expect(mockOpenUrl).toHaveBeenCalledWith(DEVICE_URL)
    expect(mockRespondAgentSignIn).toHaveBeenCalledWith('agent-1', 'accept')
    expect(screen.getByLabelText('Sign-in code').textContent).toBe('ABCD-12345')

    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    expect(mockOpenUrl).toHaveBeenCalledTimes(2)
    expect(mockRespondAgentSignIn).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(mockClearPendingSignIn).toHaveBeenCalledWith('agent-1')
    expect(mockRespondAgentSignIn).toHaveBeenCalledTimes(1)
  })

  it('cancels the sign-in when dismissed before opening the page', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(mockRespondAgentSignIn).toHaveBeenCalledWith('agent-1', 'cancel')
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })
})
