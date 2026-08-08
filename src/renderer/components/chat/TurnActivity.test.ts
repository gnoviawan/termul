import { describe, expect, it } from 'vitest'
import { formatTurnDuration } from './format-turn-duration'

describe('formatTurnDuration', () => {
  it('returns null when no duration is available', () => {
    expect(formatTurnDuration(null)).toBeNull()
  })

  it('rounds sub-second durations up to 1s without implying precision', () => {
    expect(formatTurnDuration(200)).toBe('1s')
    expect(formatTurnDuration(999)).toBe('1s')
    expect(formatTurnDuration(1_499)).toBe('1s')
  })

  it('formats seconds-only durations below one minute', () => {
    expect(formatTurnDuration(3_200)).toBe('3s')
    expect(formatTurnDuration(50_000)).toBe('50s')
    expect(formatTurnDuration(59_400)).toBe('59s')
  })

  it('rounds the one-minute boundary into minutes', () => {
    // 59.999s rounds to 60s -> 1m 0s, never "60s"
    expect(formatTurnDuration(59_999)).toBe('1m 0s')
  })

  it('formats minute-plus durations as minutes and seconds', () => {
    // 110s -> 1m 50s
    expect(formatTurnDuration(110_000)).toBe('1m 50s')
    // 3599s -> 59m 59s
    expect(formatTurnDuration(3_599_000)).toBe('59m 59s')
    // 3600s boundary rounds to 3600s -> 1h 0m 0s
    expect(formatTurnDuration(3_599_500)).toBe('1h 0m 0s')
  })

  it('formats hour-plus durations as hours, minutes, and seconds', () => {
    // 4150s -> 1h 9m 10s
    expect(formatTurnDuration(4_150_000)).toBe('1h 9m 10s')
    // 5420s -> 1h 30m 20s
    expect(formatTurnDuration(5_420_000)).toBe('1h 30m 20s')
    // 3660s -> 1h 1m 0s
    expect(formatTurnDuration(3_660_000)).toBe('1h 1m 0s')
  })

  it('keeps the user-visible label shape: Worked for <duration>', () => {
    const label = (ms: number) => `Worked for ${formatTurnDuration(ms)}`
    expect(label(50_000)).toBe('Worked for 50s')
    expect(label(110_000)).toBe('Worked for 1m 50s')
    expect(label(5_420_000)).toBe('Worked for 1h 30m 20s')
  })
})
