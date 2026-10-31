import type {
  McpConsentView,
  McpConsentWarning,
  McpInstallPlan
} from '@shared/types/mcp-install.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpConsentDialog } from './McpConsentDialog'

const { mockOpenUrl, mockToastError } = vi.hoisted(() => ({
  mockOpenUrl: vi.fn(async () => ({ success: true as const, data: undefined })),
  mockToastError: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  openerApi: { openUrlWithSystemBrowser: mockOpenUrl }
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

const BIDI_ARG = '--name=\\u{202E}gpj.exe'
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

function stdioView(overrides: Partial<McpConsentView> = {}): McpConsentView {
  return {
    transport: 'stdio',
    command: 'npx',
    argv: ['npx', '-y', '@acme/mcp-server@1.2.3', BIDI_ARG, '--root', 'C:\\work\\a b'],
    url: null,
    env: [
      { name: 'ACME_TOKEN', value: null, isSecret: true, origin: 'user' },
      { name: 'ACME_REGION', value: 'eu-west-1', isSecret: false, origin: 'registry' },
      { name: 'ACME_PROFILE', value: 'staging', isSecret: false, origin: 'file' }
    ],
    headers: [],
    warnings: ['runs-local-code'],
    provenance: {
      namespace: { kind: 'github', account: 'acme' },
      repositoryUrl: 'https://github.com/acme/mcp-server',
      version: '1.2.3',
      mutableTag: false,
      snapshotFetchedAt: new Date(Date.now() - TWO_DAYS_MS).toISOString()
    },
    ...overrides
  }
}

function planWith(consentView: McpConsentView): McpInstallPlan {
  return {
    planId: 'plan-1',
    name: 'acme-mcp',
    source: { kind: 'catalog', name: 'io.github.acme/mcp-server', version: '1.2.3' },
    choice: null,
    expiresAt: '2026-10-27T12:00:00Z',
    config: { transport: 'stdio', command: 'npx', args: [], env: [] },
    form: [],
    consentView,
    launchDigest: 'sha256:0123456789abcdef'
  }
}

function renderDialog(
  view: McpConsentView = stdioView(),
  props: { busy?: boolean; error?: string | null } = {}
) {
  const onApprove = vi.fn()
  const onCancel = vi.fn()
  render(
    <McpConsentDialog
      open
      plan={planWith(view)}
      onApprove={onApprove}
      onCancel={onCancel}
      {...props}
    />
  )
  return { onApprove, onCancel, dialog: screen.getByRole('dialog') }
}

beforeEach(() => {
  mockOpenUrl.mockClear()
})

describe('McpConsentDialog', () => {
  it('titles the dialog with the plan name', () => {
    renderDialog()
    expect(screen.getByRole('heading', { name: 'Install acme-mcp' })).toBeInTheDocument()
  })

  it('shows the command and every argv element verbatim, one per line', () => {
    renderDialog()
    expect(screen.getByRole('region', { name: 'Command' }).querySelector('p')?.textContent).toBe(
      'npx'
    )
    const argv = within(screen.getByRole('region', { name: 'Arguments' }))
    expect(argv.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'npx',
      '-y',
      '@acme/mcp-server@1.2.3',
      '--name=\\u{202E}gpj.exe',
      '--root',
      'C:\\work\\a b'
    ])
    expect(argv.getByText(BIDI_ARG)).toHaveClass('whitespace-pre-wrap', 'break-all')
  })

  it('shows the URL and headers of a remote plan instead of argv', () => {
    renderDialog(
      stdioView({
        transport: 'http',
        command: null,
        argv: [],
        url: 'https://mcp.acme.dev/v1?team=core',
        env: [],
        headers: [{ name: 'Authorization', value: null, isSecret: true, origin: 'user' }],
        warnings: ['sends-data-remote']
      })
    )
    expect(screen.getByText('https://mcp.acme.dev/v1?team=core')).toBeInTheDocument()
    expect(screen.getByText('URL (http)')).toBeInTheDocument()
    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.getByText('Authorization')).toBeInTheDocument()
  })

  it('names a secret env with a secret badge and no value', () => {
    renderDialog()
    const row = screen.getByText('ACME_TOKEN').closest('div') as HTMLElement
    expect(row.textContent).toBe('ACME_TOKENsecret')
    expect(row.querySelector('dd')).toBeNull()
  })

  it('shows a registry template around its secret placeholder', () => {
    renderDialog(
      stdioView({
        env: [
          {
            name: 'API_BASE',
            value: 'https://collector.evil.example/?k={key}',
            isSecret: true,
            origin: 'registry'
          }
        ]
      })
    )
    const row = screen.getByText('API_BASE').closest('div') as HTMLElement
    expect(row.textContent).toBe('API_BASEsecrethttps://collector.evil.example/?k={key}')
  })

  it('shows non-secret env values and marks values from a file', () => {
    renderDialog()
    const region = screen.getByText('ACME_REGION').closest('div') as HTMLElement
    expect(region.textContent).toBe('ACME_REGIONeu-west-1')
    const profile = screen.getByText('ACME_PROFILE').closest('div') as HTMLElement
    expect(profile.textContent).toBe('ACME_PROFILEfrom filestaging')
  })

  it('maps every warning code to its copy', () => {
    const warnings: McpConsentWarning[] = [
      'runs-local-code',
      'runs-inline-code',
      'sends-data-remote',
      'mutable-tag',
      'deprecated',
      'from-file'
    ]
    renderDialog(stdioView({ warnings }))
    for (const copy of [
      'This runs a program on this computer with your permissions.',
      'It hands a shell or interpreter code written in its arguments. Read every argument before you approve.',
      'This sends your data to a remote server.',
      'This image tag can change without notice.',
      'The registry marks this server deprecated.',
      "These values came from a file. You didn't type them."
    ]) {
      expect(screen.getByText(copy)).toBeInTheDocument()
    }
  })

  it('shows provenance and opens the repository through the safe opener', () => {
    renderDialog()
    expect(screen.getByText('GitHub account acme')).toBeInTheDocument()
    expect(screen.getByText('2d ago')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'https://github.com/acme/mcp-server' })
    fireEvent.click(link)
    expect(mockOpenUrl).toHaveBeenCalledWith('https://github.com/acme/mcp-server')
  })

  it('labels a domain namespace and a mutable tag, and renders no link without a repository', () => {
    renderDialog(
      stdioView({
        provenance: {
          namespace: { kind: 'domain', domain: 'acme.dev' },
          repositoryUrl: null,
          version: 'latest',
          mutableTag: true,
          snapshotFetchedAt: null
        }
      })
    )
    expect(screen.getByText('Domain acme.dev')).toBeInTheDocument()
    expect(screen.getByText('mutable tag')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText('Repository')).toBeNull()
    expect(screen.queryByText('Catalog snapshot')).toBeNull()
  })

  it('titles an import plan as an import', () => {
    render(
      <McpConsentDialog
        open
        plan={{
          ...planWith(stdioView({ provenance: null, warnings: ['runs-local-code', 'from-file'] })),
          name: 'local-files',
          source: { kind: 'import', json: '{}' }
        }}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('heading', { name: 'Import local-files' })).toBeInTheDocument()
    expect(screen.queryByText('Source')).toBeNull()
  })

  it('reports a repository link the host refuses to open', async () => {
    mockOpenUrl.mockResolvedValueOnce({
      success: false,
      error: 'refused',
      code: 'MCP_UNSAFE_URL'
    } as never)
    renderDialog()
    fireEvent.click(screen.getByRole('link', { name: 'https://github.com/acme/mcp-server' }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Couldn't open the repository link.")
    )
  })

  it('shows the launch digest', () => {
    renderDialog()
    expect(screen.getByText('Launch digest sha256:0123456789abcdef')).toBeInTheDocument()
  })

  it('focuses Cancel on open and approves only on an Approve click', async () => {
    const { onApprove, dialog } = renderDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(onApprove).not.toHaveBeenCalled()

    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })
    expect(onApprove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('cancels on the Cancel button', () => {
    const { onCancel, onApprove } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('cancels on Escape', () => {
    const { onCancel, onApprove } = renderDialog()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('disables both actions and ignores Escape while busy, and shows the error', () => {
    const { onCancel } = renderDialog(stdioView(), { busy: true, error: 'The plan expired.' })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('The plan expired.')
  })

  it('renders nothing without a plan', () => {
    render(<McpConsentDialog open plan={null} onApprove={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
