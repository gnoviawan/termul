import type { McpInstallField } from '@shared/types/mcp-catalog.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialInstallValues, McpInstallForm, splitInstallValues } from './McpInstallForm'

const { mockSelectDirectory } = vi.hoisted(() => ({
  mockSelectDirectory: vi.fn()
}))

vi.mock('@/lib/dialog-api', () => ({
  dialogApi: { selectDirectory: mockSelectDirectory }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function field(overrides: Partial<McpInstallField> & Pick<McpInstallField, 'id'>): McpInstallField {
  return {
    label: overrides.id,
    target: { kind: 'env', name: overrides.id },
    variable: null,
    isRequired: false,
    isSecret: false,
    format: 'string',
    choices: null,
    default: null,
    placeholder: null,
    description: null,
    ...overrides
  }
}

const FIELDS: McpInstallField[] = [
  field({ id: 'region', label: 'Region', placeholder: 'us-east-1', description: 'AWS region' }),
  field({ id: 'port', label: 'Port', format: 'number', default: '8080' }),
  field({ id: 'verbose', label: 'Verbose', format: 'boolean', default: 'TRUE' }),
  field({
    id: 'mode',
    label: 'Mode',
    choices: ['read', 'write'],
    target: { kind: 'argument', index: 0, name: '--mode' }
  }),
  field({
    id: 'root',
    label: 'Root folder',
    format: 'filepath',
    target: { kind: 'argument', index: 1, name: null }
  }),
  field({
    id: 'token',
    label: 'API token',
    isSecret: true,
    isRequired: true,
    target: { kind: 'header', name: 'Authorization' }
  }),
  field({ id: 'host', label: 'Host', target: { kind: 'url' } })
]

function Harness({
  fields = FIELDS,
  onChange,
  errors
}: {
  fields?: McpInstallField[]
  onChange?: (id: string, value: string) => void
  errors?: Record<string, string>
}): React.JSX.Element {
  const [values, setValues] = useState(() => initialInstallValues(fields))
  return (
    <McpInstallForm
      fields={fields}
      values={values}
      errors={errors}
      onChange={(id, value) => {
        onChange?.(id, value)
        setValues((prev) => ({ ...prev, [id]: value }))
      }}
    />
  )
}

beforeEach(() => {
  mockSelectDirectory.mockReset()
})

describe('initialInstallValues', () => {
  it('seeds every field from its default and normalises booleans', () => {
    expect(
      initialInstallValues([
        ...FIELDS,
        field({ id: 'quiet', format: 'boolean' }),
        field({ id: 'dry', format: 'boolean', default: 'no' })
      ])
    ).toEqual({
      region: '',
      port: '8080',
      verbose: 'true',
      mode: '',
      root: '',
      token: '',
      host: '',
      quiet: 'false',
      dry: 'false'
    })
  })
})

describe('splitInstallValues', () => {
  it('sends secret ids only in secretValues and every other id only in inputs', () => {
    const values = {
      region: 'eu-west-1',
      port: '9000',
      verbose: 'false',
      mode: 'read',
      root: '/srv',
      token: 'sk-live-123',
      host: 'example.com',
      stray: 'ignored'
    }
    expect(splitInstallValues(FIELDS, values)).toEqual({
      inputs: {
        region: 'eu-west-1',
        port: '9000',
        verbose: 'false',
        mode: 'read',
        root: '/srv',
        host: 'example.com'
      },
      secretValues: { token: 'sk-live-123' }
    })
  })
})

describe('McpInstallForm', () => {
  it('groups fields under Environment, Headers, Arguments and URL in that order', () => {
    render(<Harness />)
    const legends = Array.from(document.querySelectorAll('legend')).map((el) => el.textContent)
    expect(legends).toEqual(['Environment', 'Headers', 'Arguments', 'URL'])
  })

  it('renders a string field as a text input with its placeholder and help text', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Region')
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('placeholder', 'us-east-1')
    expect(input).toHaveAccessibleDescription('AWS region')
  })

  it('renders a number field as a numeric input holding the seeded default', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Port')
    expect(input).toHaveAttribute('type', 'number')
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveValue(8080)
  })

  it('renders a boolean field as a switch that writes false and true', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Verbose' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenLastCalledWith('verbose', 'false')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('renders choices as a select limited to those options', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Mode' }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'read',
      'write'
    ])
    fireEvent.click(screen.getByRole('option', { name: 'write' }))
    expect(onChange).toHaveBeenLastCalledWith('mode', 'write')
  })

  it('fills a filepath field from the host directory picker', async () => {
    mockSelectDirectory.mockResolvedValue({ success: true, data: 'C:\\work\\repo' })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByLabelText('Root folder')).toHaveValue('C:\\work\\repo'))
    expect(mockSelectDirectory).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('root', 'C:\\work\\repo')
  })

  it('leaves a filepath field alone when the picker is cancelled', async () => {
    mockSelectDirectory.mockResolvedValue({
      success: false,
      error: 'No directory selected',
      code: 'CANCELLED'
    })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(mockSelectDirectory).toHaveBeenCalledTimes(1))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Root folder')).toHaveValue('')
  })

  it('masks a secret and keeps its value out of every node but the input', () => {
    const secret = 'sk-live-very-secret-42'
    const { container } = render(<Harness />)
    const input = screen.getByLabelText('API token*')
    fireEvent.change(input, { target: { value: secret } })

    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveValue(secret)
    expect(container.textContent).not.toContain(secret)
    const leaks = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes)
        .filter((attr) => attr.value.includes(secret))
        .map((attr) => `${el.id}:${attr.name}`)
    )
    expect(leaks).toEqual([`${input.id}:value`])
  })

  it('marks required fields and shows the host error under its field', () => {
    render(<Harness errors={{ token: 'A token is required.' }} />)
    const input = screen.getByLabelText('API token*')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('A token is required.')
    expect(screen.getByLabelText('Region')).toHaveAttribute('aria-required', 'false')
  })

  it('disables every control when disabled', () => {
    render(
      <McpInstallForm
        fields={FIELDS}
        values={initialInstallValues(FIELDS)}
        onChange={vi.fn()}
        disabled
      />
    )
    expect(screen.getByLabelText('Region')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Verbose' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Mode' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Browse' })).toBeDisabled()
  })
})
