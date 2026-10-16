import { render, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TopRowPlatform, TopRowRoles } from '@/lib/top-row'
import { TopRowProvider, usePaneTopRow, useTopRow, useTopRowPlatform } from './top-row-context'

const roles: TopRowRoles = {
  topEdgeLeafIds: new Set(['A', 'B']),
  rightmostLeafId: 'B',
  leftmostLeafId: 'A',
  controlsOwner: 'pane',
  showPanelOwner: 'pane'
}
const desktop: TopRowPlatform = { dragRegions: true, windowControls: true, trafficLights: false }

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <TopRowProvider roles={roles} platform={desktop}>
      {children}
    </TopRowProvider>
  )
}

describe('top row context', () => {
  it('returns null without a provider (classic look)', () => {
    expect(renderHook(() => useTopRow()).result.current).toBeNull()
    expect(renderHook(() => usePaneTopRow('A')).result.current).toBeNull()
  })

  it('falls back to the call-time platform without a provider', () => {
    // jsdom is not Tauri: web, all false.
    expect(renderHook(() => useTopRowPlatform()).result.current).toEqual({
      dragRegions: false,
      windowControls: false,
      trafficLights: false
    })
  })

  it('publishes roles and platform', () => {
    const { result } = renderHook(() => useTopRow(), { wrapper })
    expect(result.current?.roles).toBe(roles)
    expect(result.current?.platform).toBe(desktop)
    expect(renderHook(() => useTopRowPlatform(), { wrapper }).result.current).toBe(desktop)
  })

  it('derives each pane role', () => {
    expect(renderHook(() => usePaneTopRow('A'), { wrapper }).result.current).toEqual({
      topEdge: true,
      leftEdge: true,
      dragRegion: true,
      windowControls: false
    })
    expect(renderHook(() => usePaneTopRow('B'), { wrapper }).result.current).toEqual({
      topEdge: true,
      leftEdge: false,
      dragRegion: true,
      windowControls: true
    })
    expect(renderHook(() => usePaneTopRow('C'), { wrapper }).result.current?.topEdge).toBe(false)
  })

  it('keeps the context value stable across re-renders with the same roles', () => {
    const seen: unknown[] = []
    function Probe(): null {
      seen.push(useTopRow())
      return null
    }
    const { rerender } = render(
      <TopRowProvider roles={roles} platform={desktop}>
        <Probe />
      </TopRowProvider>
    )
    rerender(
      <TopRowProvider roles={roles} platform={desktop}>
        <Probe />
      </TopRowProvider>
    )
    expect(new Set(seen).size).toBe(1)
  })
})
