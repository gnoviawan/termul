/**
 * Component tests for the gh-1105 server setup / reconfigure wizard.
 *
 * `webSetupApi` (`@/lib/web-setup-api`) is owned by a parallel slice — it's
 * mocked here per the settled contract in `shared/types/server-setup.types`.
 * Radix Select portals don't render reliably under jsdom, so the
 * `@/components/ui/select` module is shimmed with a native `<select>` (same
 * convention as `AgentLauncher.test.tsx`), forwarding `id`/`disabled`/ARIA
 * props so the Label htmlFor ↔ control id wiring still applies.
 */

import type { ServerSetupAnswers } from '@shared/types/server-setup.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api, logError } = vi.hoisted(() => ({
  api: {
    getStatus: vi.fn(),
    validate: vi.fn(),
    apply: vi.fn(),
    getServerConfig: vi.fn(),
    applyServerConfig: vi.fn()
  },
  logError: vi.fn()
}))

vi.mock('@/lib/web-setup-api', () => ({ webSetupApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: logError }))

vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext, Children, isValidElement } = await import('react')
  type Item = { value: string; label: React.ReactNode }
  const SelectCtx = createContext<{
    value?: string
    disabled?: boolean
    onValueChange?: (v: string) => void
    items: Item[]
  }>({ items: [] })
  const SelectItem = (_props: { value: string; children: React.ReactNode }) => null
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children
    }: {
      value?: string
      onValueChange?: (v: string) => void
      disabled?: boolean
      children: React.ReactNode
    }) => {
      const items: Item[] = []
      const walk = (node: React.ReactNode): void => {
        if (!isValidElement(node)) return
        if (node.type === SelectItem) {
          items.push({ value: node.props.value, label: node.props.children })
        }
        Children.forEach(node.props.children, walk)
      }
      Children.forEach(children, walk)
      return (
        <SelectCtx.Provider value={{ value, onValueChange, disabled, items }}>
          {children}
        </SelectCtx.Provider>
      )
    },
    SelectTrigger: ({
      children: _children,
      ...props
    }: {
      children?: React.ReactNode
      [k: string]: unknown
    }) => {
      const ctx = useContext(SelectCtx)
      return (
        <select
          {...props}
          disabled={ctx.disabled}
          value={ctx.value ?? ''}
          onChange={(e) => ctx.onValueChange?.(e.target.value)}
        >
          {ctx.items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      )
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem,
    SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectLabel: () => null,
    SelectSeparator: () => null,
    SelectScrollUpButton: () => null,
    SelectScrollDownButton: () => null
  }
})

import { ServerSetupWizard } from './ServerSetupWizard'

const DEFAULT_ANSWERS: ServerSetupAnswers = {
  host: '127.0.0.1',
  port: 8080,
  sessionsDir: '/home/u/.local/state/termul/sessions',
  projectsFile: '/home/u/.local/state/termul/projects.json',
  allowRemoteWrites: false,
  updateChannel: null,
  updateIntervalSecs: 21600
}

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string, code = 'TEST_ERROR') => ({
  success: false as const,
  error,
  code
})

function statusResponse(defaults: ServerSetupAnswers = DEFAULT_ANSWERS, configError?: string) {
  return ok({ setupRequired: true, configError, defaults })
}

describe('ServerSetupWizard (setup mode)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // The restarting screen's /health poll must never reach a real socket.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server')))
    api.getStatus.mockResolvedValue(statusResponse())
    api.validate.mockResolvedValue(ok({ ok: true, fieldErrors: {} }))
    api.apply.mockResolvedValue(ok({ ok: true, host: '127.0.0.1', port: 8080 }))
    api.getServerConfig.mockResolvedValue(ok({ config: DEFAULT_ANSWERS }))
    api.applyServerConfig.mockResolvedValue(ok({ ok: true, host: '127.0.0.1', port: 8080 }))
  })

  it('prefills the form from getStatus() defaults', async () => {
    render(<ServerSetupWizard mode="setup" />)

    await waitFor(() => expect(screen.getByText('Set up Termul')).toBeInTheDocument())
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Port')).toHaveValue(8080)
    expect(screen.getByLabelText('Where can Termul be reached?')).toHaveValue('127.0.0.1')
  })

  it('explains when a saved config could not be used', async () => {
    api.getStatus.mockResolvedValue(
      statusResponse(DEFAULT_ANSWERS, "invalid host 'bogus', port must not be 0")
    )
    render(<ServerSetupWizard mode="setup" />)

    const notice = await screen.findByText(/couldn't be used/)
    expect(notice).toHaveTextContent("invalid host 'bogus'")
    // The form still pre-fills so the operator can correct the values.
    expect(screen.getByLabelText('Port')).toHaveValue(8080)
  })

  it('does not fetch when initial answers are provided', () => {
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    expect(api.getStatus).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Port')).toHaveValue(8080)
  })

  it('shows the remote-writes switch only for a network bind', () => {
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    // Loopback default: the question is skipped, like the CLI wizard.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Where can Termul be reached?'), {
      target: { value: '0.0.0.0' }
    })
    expect(
      screen.getByRole('switch', { name: 'Let other devices make changes' })
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Where can Termul be reached?'), {
      target: { value: '127.0.0.1' }
    })
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('reveals the advanced fields behind Advanced options', () => {
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    expect(screen.queryByLabelText('Folder for terminal data')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))
    expect(screen.getByLabelText('Folder for terminal data')).toHaveValue(
      DEFAULT_ANSWERS.sessionsDir
    )
    expect(screen.getByLabelText('Projects list file')).toHaveValue(DEFAULT_ANSWERS.projectsFile)
  })

  it('asks the update interval only when an update channel is picked', () => {
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))
    expect(screen.queryByLabelText('How often to check for updates')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Updates'), { target: { value: 'stable' } })
    expect(screen.getByLabelText('How often to check for updates')).toHaveValue(21600)
  })

  it('shows per-field errors from validate inline and does not apply', async () => {
    api.validate.mockResolvedValueOnce(
      ok({
        ok: false,
        fieldErrors: { port: 'That port is already in use.' }
      })
    )
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    fireEvent.submit(screen.getByRole('form', { name: 'Set up Termul' }))

    await waitFor(() =>
      expect(screen.getByText('That port is already in use.')).toBeInTheDocument()
    )
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('shows a form-level error when the server cannot be reached', async () => {
    api.validate.mockResolvedValueOnce(fail('connection refused', 'NETWORK_ERROR'))
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    fireEvent.submit(screen.getByRole('form', { name: 'Set up Termul' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server')
    )
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('resets allowRemoteWrites when the bind goes back to loopback', async () => {
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    fireEvent.change(screen.getByLabelText('Where can Termul be reached?'), {
      target: { value: '0.0.0.0' }
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Let other devices make changes' }))
    fireEvent.change(screen.getByLabelText('Where can Termul be reached?'), {
      target: { value: '127.0.0.1' }
    })
    fireEvent.submit(screen.getByRole('form', { name: 'Set up Termul' }))

    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    expect(api.validate.mock.calls[0][0].allowRemoteWrites).toBe(false)
  })

  it('hands off to the restarting screen after a successful apply', async () => {
    api.apply.mockResolvedValueOnce(
      ok({ ok: true, host: '0.0.0.0', port: 9090, webAuthToken: 'tok-1' })
    )
    render(<ServerSetupWizard mode="setup" initial={DEFAULT_ANSWERS} />)

    fireEvent.submit(screen.getByRole('form', { name: 'Set up Termul' }))

    await waitFor(() => expect(screen.getByText('Restarting Termul')).toBeInTheDocument())
    expect(api.apply).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1' }))
  })

  it('shows the load error with a retry path', async () => {
    api.getStatus.mockReset()
    api.getStatus.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(statusResponse())
    render(<ServerSetupWizard mode="setup" />)

    await waitFor(() =>
      expect(screen.getByText(/Could not load the server settings/)).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('Set up Termul')).toBeInTheDocument())
    expect(api.getStatus).toHaveBeenCalledTimes(2)
  })
})

describe('ServerSetupWizard (reconfigure mode)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no server')))
    api.getStatus.mockResolvedValue(statusResponse())
    api.validate.mockResolvedValue(ok({ ok: true, fieldErrors: {} }))
    api.apply.mockResolvedValue(ok({ ok: true, host: '127.0.0.1', port: 8080 }))
    api.getServerConfig.mockResolvedValue(ok({ config: DEFAULT_ANSWERS }))
    api.applyServerConfig.mockResolvedValue(ok({ ok: true, host: '127.0.0.1', port: 8080 }))
  })

  it('prefills from getServerConfig() and submits through applyServerConfig', async () => {
    api.getServerConfig.mockResolvedValueOnce(
      ok({ config: { ...DEFAULT_ANSWERS, host: '0.0.0.0', allowRemoteWrites: true } })
    )
    render(<ServerSetupWizard mode="reconfigure" />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and restart' })).toBeInTheDocument()
    )
    expect(api.getServerConfig).toHaveBeenCalledTimes(1)
    // A public-bind config surfaces the remote-writes question, answered on.
    expect(screen.getByRole('switch', { name: 'Let other devices make changes' })).toBeChecked()

    fireEvent.submit(screen.getByRole('form', { name: 'Server settings' }))
    await waitFor(() =>
      expect(api.applyServerConfig).toHaveBeenCalledWith(
        expect.objectContaining({ host: '0.0.0.0', allowRemoteWrites: true })
      )
    )
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('does not fetch when initial answers are provided', () => {
    render(<ServerSetupWizard mode="reconfigure" initial={DEFAULT_ANSWERS} />)

    expect(api.getServerConfig).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Port')).toHaveValue(8080)
  })
})
