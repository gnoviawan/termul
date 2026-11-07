import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useReportBugOpen, useReportBugStore } from './report-bug-store'

function OpenFlagProbe(): React.JSX.Element {
  const open = useReportBugOpen()
  return <span data-testid="open-flag">{String(open)}</span>
}

describe('report-bug-store', () => {
  beforeEach(() => {
    useReportBugStore.setState({ open: false })
  })

  it('opens and closes through the store actions', () => {
    expect(useReportBugStore.getState().open).toBe(false)

    useReportBugStore.getState().openReport()
    expect(useReportBugStore.getState().open).toBe(true)

    useReportBugStore.getState().close()
    expect(useReportBugStore.getState().open).toBe(false)
  })

  it('exposes the open flag reactively through useReportBugOpen', () => {
    render(<OpenFlagProbe />)
    const flag = screen.getByTestId('open-flag')
    expect(flag.textContent).toBe('false')

    act(() => useReportBugStore.getState().openReport())
    expect(flag.textContent).toBe('true')
  })
})
