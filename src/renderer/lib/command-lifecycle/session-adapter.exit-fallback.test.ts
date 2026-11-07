import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/stores/terminal-store', () => ({ useTerminalStore: undefined }))

import {
  disposeSessionAdapter,
  forwardSessionExit,
  forwardSessionLifecycle
} from './session-adapter'

const rejections: unknown[] = []
const onRejection = (reason: unknown) => {
  rejections.push(reason)
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(async () => {
  disposeSessionAdapter()
  await flushMacrotask()
  process.off('unhandledRejection', onRejection)
  rejections.length = 0
})

const lifecycleEvent: SessionLifecyclePayload = {
  type: 'session_lifecycle',
  terminal_id: 'pty-missing',
  session_id: 's',
  kind: 'InitShell',
  nonce: 'n',
  prompt_suppressed: true,
  line_empty: true,
  exit_code: null,
  prompt_generation: 1,
  cwd: '/repo'
}

it('does not reject when exit forwarding finds no terminal store', async () => {
  process.on('unhandledRejection', onRejection)
  try {
    forwardSessionExit('pty-missing')
    await import('@/stores/terminal-store')
    await flushMacrotask()
    expect(rejections).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

it('does not reject when lifecycle forwarding finds no terminal store', async () => {
  process.on('unhandledRejection', onRejection)
  try {
    forwardSessionLifecycle(lifecycleEvent)
    await import('@/stores/terminal-store')
    await flushMacrotask()
    expect(rejections).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})
