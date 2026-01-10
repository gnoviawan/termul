/**
 * @deprecated Use the Zustand store instead: import { useTerminals, useActiveTerminal, useTerminalActions } from '@/stores/terminal-store'
 */
import { useState } from 'react'
import type { Terminal, TerminalLine } from '@/types/project'

const mockOutput: TerminalLine[] = [
  { type: 'output', content: 'Windows PowerShell' },
  { type: 'output', content: 'Copyright (C) Microsoft Corporation. All rights reserved.' },
  { type: 'output', content: '' },
  {
    type: 'info',
    content:
      'Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows'
  },
  { type: 'success', content: '➜  web-app git:(main) npm run dev' },
  { type: 'output', content: '> web-app@0.1.0 dev' },
  { type: 'output', content: '> next dev' },
  { type: 'output', content: '' },
  { type: 'output', content: 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000' },
  {
    type: 'output',
    content: 'event - compiled client and server successfully in 1241 ms (156 modules)'
  },
  { type: 'warning', content: 'warn  - Fast Refresh had to perform a full reload.' },
  { type: 'output', content: 'wait  - compiling...' },
  {
    type: 'output',
    content: 'event - compiled client and server successfully in 89 ms (156 modules)'
  },
  { type: 'info', content: 'info  - Loaded env from .env.local' }
]

const initialTerminals: Terminal[] = [
  {
    id: '1',
    name: 'Dev Server',
    projectId: '1',
    shell: 'powershell',
    isActive: true,
    output: mockOutput
  },
  { id: '2', name: 'Build Check', projectId: '1', shell: 'powershell', output: [] }
]

export function useTerminals(projectId: string) {
  const [terminals, setTerminals] = useState<Terminal[]>(initialTerminals)
  const [activeTerminalId, setActiveTerminalId] = useState<string>('1')

  const projectTerminals = terminals.filter((t) => t.projectId === projectId)
  const activeTerminal = projectTerminals.find((t) => t.id === activeTerminalId)

  const selectTerminal = (id: string) => {
    setActiveTerminalId(id)
    setTerminals((prev) => prev.map((t) => ({ ...t, isActive: t.id === id })))
  }

  const addTerminal = (name: string, shell: Terminal['shell'] = 'powershell') => {
    const newTerminal: Terminal = {
      id: Date.now().toString(),
      name,
      projectId,
      shell,
      output: []
    }
    setTerminals((prev) => [...prev, newTerminal])
    setActiveTerminalId(newTerminal.id)
    return newTerminal
  }

  const closeTerminal = (id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id))
    if (activeTerminalId === id) {
      const remaining = projectTerminals.filter((t) => t.id !== id)
      setActiveTerminalId(remaining[0]?.id || '')
    }
  }

  return {
    terminals: projectTerminals,
    activeTerminal,
    activeTerminalId,
    selectTerminal,
    addTerminal,
    closeTerminal
  }
}
