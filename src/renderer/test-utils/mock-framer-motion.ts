/**
 * Shared partial framer-motion mock for tests that assert animation wiring
 * structurally (which props reach `motion.div` / `AnimatePresence`, whether
 * `useReducedMotion` branches) instead of pixels or timing.
 *
 * The installed mock delegates to the real module — recording wrappers
 * render the actual `motion.div` / `AnimatePresence`, so DOM structure and
 * behavior are unchanged while props are captured for assertions.
 *
 * Per-test-file state is module-level (vitest isolates module graphs per
 * test file). Usage:
 *
 *   import {
 *     framerMotionTestState,
 *     resetFramerMotionTestState
 *   } from '@/test-utils/mock-framer-motion'
 *
 *   vi.mock('framer-motion', async (importOriginal) => {
 *     const { installFramerMotionMock } = await import('@/test-utils/mock-framer-motion')
 *     return installFramerMotionMock(importOriginal)
 *   })
 *
 *   beforeEach(() => resetFramerMotionTestState())
 */
export const framerMotionTestState = {
  /** Every props object passed to `motion.div` — one entry per render. */
  motionDivPropsLog: [] as Array<Record<string, unknown>>,
  /** Every props object passed to `AnimatePresence`. */
  animatePresencePropsLog: [] as Array<Record<string, unknown>>,
  /** What the mocked `useReducedMotion()` returns — flip per test. */
  reducedMotion: { current: false }
}

/** Reset captured props + reduced-motion flag; call in beforeEach. */
export function resetFramerMotionTestState(): void {
  framerMotionTestState.motionDivPropsLog.length = 0
  framerMotionTestState.animatePresencePropsLog.length = 0
  framerMotionTestState.reducedMotion.current = false
}

/**
 * `vi.mock` factory for 'framer-motion'. Returns a module that is the real
 * implementation except:
 *  - `useReducedMotion` reads {@link framerMotionTestState.reducedMotion}
 *  - `motion.div` records props then renders the real component
 *  - `AnimatePresence` records props then renders the real component
 */
export async function installFramerMotionMock(
  importOriginal: () => Promise<typeof import('framer-motion')>
): Promise<Record<string, unknown>> {
  const React = await import('react')
  const actual = await importOriginal()

  const RecordingDiv = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    function RecordingDiv(props, ref) {
      framerMotionTestState.motionDivPropsLog.push(props)
      return React.createElement(actual.motion.div as React.ElementType, { ...props, ref })
    }
  )

  const RecordingPresence = (props: Record<string, unknown>): React.JSX.Element => {
    framerMotionTestState.animatePresencePropsLog.push(props)
    return React.createElement(actual.AnimatePresence as React.ElementType, props)
  }

  return {
    ...actual,
    useReducedMotion: () => framerMotionTestState.reducedMotion.current,
    motion: new Proxy(actual.motion, {
      get(target, prop, receiver) {
        return prop === 'div' ? RecordingDiv : Reflect.get(target, prop, receiver)
      }
    }),
    AnimatePresence: RecordingPresence
  }
}
