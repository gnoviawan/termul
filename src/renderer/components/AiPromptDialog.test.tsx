import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { AiPromptDialog } from './AiPromptDialog'

const context = {
  sourceBranch: 'feature/i18n',
  targetBranch: 'main',
  worktreePath: '/tmp/termul-i18n',
  projectName: 'Termul'
}

describe('AiPromptDialog template metadata', () => {
  beforeEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  it('updates template labels on language change without translating the model prompt', async () => {
    render(<AiPromptDialog isOpen onClose={vi.fn()} context={context} />)

    expect(screen.getByRole('button', { name: 'Cursor Default' })).toHaveAttribute(
      'title',
      'Standard prompt for Cursor AI editor'
    )
    expect(screen.getByText('Cursor Default — Paste this into Cursor')).toBeInTheDocument()
    const generatedPrompt = screen.getByText(/I'm working on the feature\/i18n branch in Termul/)
    const englishPrompt = generatedPrompt.textContent

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(screen.getByRole('button', { name: 'Cursor 默认模板' })).toHaveAttribute(
      'title',
      '适用于 Cursor AI 编辑器的标准提示词'
    )
    expect(screen.getByText('Cursor 默认模板 — 粘贴到 Cursor')).toBeInTheDocument()
    expect(generatedPrompt.textContent).toBe(englishPrompt)
  })
})
