/**
 * The window `patch-check.ts` grabs: one sample per Termul native patch, each
 * painted big and in a colour the checker can find. Writes the bounds of every
 * sample, the addon's native window handle and this pid to the ready file.
 *
 * bun tools/native/patch-scene.tsx <ready.json>
 */
import { renameSync, writeFileSync } from 'node:fs'
import { type GpuixTheme, type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { registerTerminalFonts } from '../../src/terminal/fonts'
import { LONG_VALUE, SAMPLES, SCENE, type Sample } from './samples'

const [readyFile] = process.argv.slice(2)

const mono: GpuixTheme = {
  text: '#ffffff',
  codeText: '#ffffff',
  codeWash: '#00000000',
  fontSans: 'Paper Mono',
  fontMono: 'Paper Mono',
  metrics: { mdTextSize: 32, mdLineHeight: 44 }
}
const THEMES: Record<'link' | 'codeFull' | 'codeHalf', GpuixTheme> = {
  link: { ...mono, link: '#ff0000', linkUnderline: '#ff0000' },
  codeFull: mono,
  codeHalf: { ...mono, metrics: { ...mono.metrics, mdInlineCodeScale: 0.5 } }
}
const SOURCES = { link: '[lllllll](https://x.dev)', codeFull: '`MMMMMMM`', codeHalf: '`MMMMMMM`' }

function App() {
  const renderer = useGpuixRequired()
  const refs = useRef<Partial<Record<Sample, PublicInstance | null>>>({})
  // GPUI resolves a family at first use, so nothing names Paper Mono before registerFont returns.
  const [fontsReady, setFontsReady] = useState(false)
  const [url, setUrl] = useState('about:blank')
  useEffect(() => {
    registerTerminalFonts(renderer)
    setFontsReady(true)
  }, [renderer])
  useEffect(() => {
    if (!fontsReady) return
    const navigate = setTimeout(() => setUrl(LONG_VALUE), 200)
    const timer = setTimeout(() => {
      const bounds = Object.fromEntries(
        SAMPLES.map((sample) => {
          const node = refs.current[sample]
          return [sample, node ? renderer.getElementBounds?.(node.id) : null]
        })
      )
      const handle = (
        renderer as { getNativeWindowHandle?(): { kind: string; id?: number | null } | null }
      ).getNativeWindowHandle?.()
      writeFileSync(`${readyFile}.tmp`, JSON.stringify({ bounds, handle: handle ?? null, pid: process.pid }))
      renameSync(`${readyFile}.tmp`, readyFile as string)
    }, 800)
    return () => {
      clearTimeout(navigate)
      clearTimeout(timer)
    }
  }, [renderer, fontsReady])
  if (!fontsReady) return null
  const box = (sample: Sample, child: ReactNode) => (
    <div
      key={sample}
      ref={(node: PublicInstance | null) => {
        refs.current[sample] = node
      }}
      style={{ padding: 8, alignSelf: 'flex-start' }}
    >
      {child}
    </div>
  )
  const glyphs = { fontFamily: 'Paper Mono', fontSize: 48, lineHeight: 60, color: '#ffffff' }
  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#000000', flexDirection: 'column' }}>
      <div style={{ flexDirection: 'row' }}>
        {box('upright', <text style={glyphs}>|||||||</text>)}
        {box('italic', <text style={{ ...glyphs, fontStyle: 'italic' }}>|||||||</text>)}
      </div>
      {(['link', 'codeFull', 'codeHalf'] as const).map((sample) =>
        box(sample, <markdown source={SOURCES[sample]} theme={THEMES[sample]} />)
      )}
      {box(
        'input',
        <input
          value={url}
          style={{ width: 240, height: 40, fontFamily: 'Paper Mono', fontSize: 28, color: '#ffffff' }}
        />
      )}
    </div>
  )
}

if (readyFile) {
  render(<App />, {
    title: 'termul-native-patch-check',
    width: SCENE.width,
    height: SCENE.height,
    focus: false
  })
}
