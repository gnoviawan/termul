import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mockProject } from '@/lib/test-utils/store'
import { ProjectIcon } from './ProjectIcon'

describe('ProjectIcon', () => {
  it('renders the resolved data-URI image when project.icon is set', () => {
    const project = mockProject({
      icon: { dataUri: 'data:image/svg+xml;base64,QUJD', mime: 'image/svg+xml', source: 'file' }
    })
    const { container } = render(<ProjectIcon project={project} size={16} />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/svg+xml;base64,QUJD')
    expect(img?.className).toContain('rounded')
    expect(img?.className).toContain('object-cover')
  })

  it('renders a colored monogram tile when no icon is resolved', () => {
    const project = mockProject({ name: 'termul', color: 'purple' })
    const { container } = render(<ProjectIcon project={project} size={16} />)
    expect(container.querySelector('img')).toBeNull()
    const tile = container.querySelector('span')
    expect(tile).not.toBeNull()
    expect(tile?.textContent).toBe('T')
    expect(tile?.className).toContain('bg-project-purple')
    expect(tile?.className).toContain('uppercase')
    // Decorative glyph inside rows that already carry the name.
    expect(tile?.getAttribute('aria-hidden')).toBe('true')
  })

  it('falls back to a placeholder letter for an empty name', () => {
    const project = mockProject({ name: '', color: 'gray' })
    const { container } = render(<ProjectIcon project={project} />)
    expect(container.querySelector('span')?.textContent).toBe('?')
  })

  it('uses only semantic tokens — no Tailwind palette primitives', () => {
    const project = mockProject({ color: 'red' })
    const { container } = render(<ProjectIcon project={project} />)
    const cls = container.firstElementChild?.className ?? ''
    for (const banned of ['text-white', 'bg-black', 'bg-red-500', 'text-gray-']) {
      expect(cls).not.toContain(banned)
    }
  })
})
