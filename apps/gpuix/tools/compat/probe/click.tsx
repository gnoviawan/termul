/**
 * Probe behind compat event bubbling: which ancestors GPUIX delivers a click
 * to when the child has a fill, a hover style, its own handler, or
 * pointer-events. Run through `click-run.ts`; results go to /tmp/gpuix-c1/click.log.
 */

import { appendFileSync } from 'node:fs'
import { render } from '@gpuix/react'

const log = (m: string) => appendFileSync('/tmp/gpuix-c1/click.log', m + '\n')

function Probe() {
  return (
    <div
      testId="root"
      style={{
        width: 1280,
        height: 800,
        backgroundColor: '#111',
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        color: '#eee'
      }}
    >
      <div
        testId="parent-a"
        onClick={() => log('parent-a click')}
        style={{ width: 300, height: 60, backgroundColor: '#333', padding: 10 }}
      >
        <div testId="child-bg" style={{ width: 100, height: 30, backgroundColor: '#a33' }}>
          <text>bg child</text>
        </div>
      </div>
      <div
        testId="parent-b"
        onClick={() => log('parent-b click')}
        style={{ width: 300, height: 60, backgroundColor: '#333', padding: 10 }}
      >
        <div
          testId="child-hover"
          style={{ width: 100, height: 30, hover: { backgroundColor: '#3a3' } }}
        >
          <text>hover child</text>
        </div>
      </div>
      <div
        testId="parent-c"
        onClick={() => log('parent-c click')}
        style={{ width: 300, height: 60, backgroundColor: '#333', padding: 10 }}
      >
        <div
          testId="child-click"
          onClick={() => log('child-click click')}
          style={{ width: 100, height: 30, backgroundColor: '#33a' }}
        >
          <text>click child</text>
        </div>
      </div>
      <div
        testId="parent-d"
        onClick={() => log('parent-d click')}
        style={{
          width: 300,
          height: 60,
          backgroundColor: '#333',
          padding: 10,
          pointerEvents: 'none'
        }}
      >
        <div
          testId="child-auto"
          onClick={() => log('child-auto click')}
          style={{ width: 100, height: 30, backgroundColor: '#33a', pointerEvents: 'auto' }}
        >
          <text>auto child</text>
        </div>
      </div>
      <div
        testId="parent-e"
        onClick={() => log('parent-e click')}
        onMouseEnter={() => log('parent-e enter')}
        style={{ width: 300, height: 60, backgroundColor: '#333', padding: 10 }}
      >
        <div
          testId="child-abs"
          style={{
            position: 'absolute',
            left: 150,
            top: 10,
            width: 100,
            height: 30,
            backgroundColor: '#3aa'
          }}
        >
          <text>abs child</text>
        </div>
      </div>
      <div
        testId="parent-f"
        style={{
          width: 300,
          height: 60,
          backgroundColor: '#333',
          padding: 10,
          pointerEvents: 'none'
        }}
      >
        <div
          testId="child-f"
          onClick={() => log('child-f click')}
          style={{ width: 100, height: 30, backgroundColor: '#33a' }}
        >
          <text>f child</text>
        </div>
      </div>
      <div
        testId="parent-g"
        onClick={() => log('parent-g click')}
        style={{ width: 300, height: 60, backgroundColor: '#333', padding: 10 }}
      >
        <div
          testId="mid-g"
          style={{ width: 200, height: 40, backgroundColor: '#555', pointerEvents: 'none' }}
        >
          <div
            testId="child-g"
            onClick={() => log('child-g click')}
            style={{ width: 100, height: 30, backgroundColor: '#3a3' }}
          >
            <text>g child</text>
          </div>
        </div>
      </div>
    </div>
  )
}
render(<Probe />, { title: 'click', width: 1280, height: 800, focus: false })
