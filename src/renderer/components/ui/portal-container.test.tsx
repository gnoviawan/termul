import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { PortalContainerContext } from './portal-container'

afterEach(cleanup)

/** The element Radix portalled into: the parent of the popper wrapper. */
function portalTarget(content: HTMLElement): HTMLElement | null {
  return content.closest('[data-radix-popper-content-wrapper]')?.parentElement ?? null
}

function OpenPopover(): React.JSX.Element {
  return (
    <Popover open>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Popover body</PopoverContent>
    </Popover>
  )
}

describe('portal container', () => {
  it('without a provider, popovers portal to document.body (the app)', () => {
    render(<OpenPopover />)
    expect(portalTarget(screen.getByText('Popover body'))).toBe(document.body)
  })

  it('without a provider, menus portal to document.body (the app)', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>Menu body</DropdownMenuContent>
      </DropdownMenu>
    )
    expect(portalTarget(screen.getByText('Menu body'))).toBe(document.body)
  })

  it('a provided container receives the portal instead', () => {
    const layer = document.createElement('div')
    document.body.append(layer)
    render(
      <PortalContainerContext.Provider value={layer}>
        <OpenPopover />
      </PortalContainerContext.Provider>
    )
    expect(portalTarget(screen.getByText('Popover body'))).toBe(layer)
    layer.remove()
  })
})
