import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FrontmatterProperties } from './FrontmatterProperties'

describe('FrontmatterProperties', () => {
  it('rejects empty key without calling onChange', () => {
    const onChange = vi.fn()
    render(<FrontmatterProperties data={{ title: 'Doc' }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /add property/i }))
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))

    expect(screen.getByText('Key cannot be empty')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects duplicate key without calling onChange', () => {
    const onChange = vi.fn()
    render(<FrontmatterProperties data={{ title: 'Doc' }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /add property/i }))
    fireEvent.change(screen.getByPlaceholderText('Property key'), {
      target: { value: 'title' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }))

    expect(screen.getByText('Key already exists')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits an edited scalar on blur without losing its accessible label', () => {
    const onChange = vi.fn()
    render(<FrontmatterProperties data={{ title: 'Doc' }} onChange={onChange} />)

    const titleInput = screen.getByLabelText('title')
    fireEvent.focus(titleInput)
    fireEvent.change(titleInput, { target: { value: 'Readable Doc' } })
    fireEvent.blur(titleInput)

    expect(onChange).toHaveBeenCalledWith({ title: 'Readable Doc' })
    expect(screen.getByLabelText('title')).toBe(titleInput)
  })

  it('removeKey calls onChange with the key removed', () => {
    const onChange = vi.fn()
    render(<FrontmatterProperties data={{ title: 'Doc', status: 'draft' }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove status' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ title: 'Doc' })
  })

  it('removeArrayItem calls onChange with updated array', () => {
    const onChange = vi.fn()
    render(<FrontmatterProperties data={{ context: ['alpha', 'beta'] }} onChange={onChange} />)

    expect(screen.getByRole('group', { name: 'context' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove alpha from context' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ context: ['beta'] })
  })

  it('labels nested read-only values by their property key', () => {
    render(
      <FrontmatterProperties
        data={{ metadata: { kind: 'nested', display: 'path: /very/long/value' } }}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByRole('group', { name: 'metadata' })).toBeTruthy()
  })
})
