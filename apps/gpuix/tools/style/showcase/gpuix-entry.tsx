/**
 * GPUIX side of the showcase: the same swatch tree, styled only by tw().
 *   SHOWCASE_THEME=termul bun tools/style/showcase/gpuix-entry.tsx
 * Prints "showcase ready" once fonts are registered and the tree is mounted.
 */
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { registerTermulFonts } from '../../../src/style/fonts'
import { resolveTwTheme } from '../../../src/style/theme'
import { createTw } from '../../../src/style/tw'
import { SANS_FAMILY } from '../../../src/style/utilities'
import { cellRect, SWATCHES, type SwatchNode } from './swatches'

const tw = createTw(resolveTwTheme(process.env.SHOWCASE_THEME ?? 'termul'))
const color = (name: string) => tw(`text-${name}`).color

function Node({ node }: { node: SwatchNode }) {
  const style = tw(node.classes)
  if (node.tag === 'input') return <input value={node.text ?? ''} style={style} />
  return (
    <div style={style}>
      {node.text !== undefined ? (
        <text>{node.text}</text>
      ) : (
        node.children?.map((child, i) => <Node key={i} node={child} />)
      )}
    </div>
  )
}

function Showcase() {
  const renderer = useGpuixRequired()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    registerTermulFonts(renderer)
    setReady(true)
  }, [renderer])
  useEffect(() => {
    if (ready) setTimeout(() => console.log('showcase ready'), 500)
  }, [ready])
  return (
    <div
      style={{
        ...tw('bg-background'),
        position: 'relative',
        width: 1280,
        height: 800,
        color: color('foreground'),
        fontFamily: SANS_FAMILY,
        fontSize: 16,
        lineHeight: 24
      }}
    >
      {ready &&
        SWATCHES.map((swatch, i) => {
          const r = cellRect(i)
          return (
            <div
              key={swatch.id}
              style={{
                ...tw(swatch.surface),
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: r.width,
                height: r.height,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {swatch.width ? (
                <div style={{ width: swatch.width, display: 'flex' }}>
                  <Node node={swatch.node} />
                </div>
              ) : (
                <Node node={swatch.node} />
              )}
            </div>
          )
        })}
    </div>
  )
}

render(<Showcase />, {
  title: 'tw showcase',
  width: 1280,
  height: 800,
  focus: false,
  keyboardFocusDim: false
})
