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
import {
  BLUR,
  BULLET,
  CODE_PAD,
  LONG_VALUE,
  SAMPLES,
  type Sample,
  SCENE,
  GRID,
  TABLE,
  TABLE_HEADER_FILL,
  TRACKING
} from './samples'

const [readyFile] = process.argv.slice(2)

const mono: GpuixTheme = {
  text: '#ffffff',
  codeText: '#ffffff',
  codeWash: '#00000000',
  fontSans: 'Paper Mono',
  fontMono: 'Paper Mono',
  metrics: { mdTextSize: 32, mdLineHeight: 44 }
}
type MarkdownSample = 'link' | 'codeFull' | 'codeHalf' | 'codeTight' | 'codePad' | 'table' | 'bullet'
const THEMES: Record<MarkdownSample, GpuixTheme> = {
  link: { ...mono, link: '#ff0000', linkUnderline: '#ff0000' },
  codeFull: mono,
  codeHalf: { ...mono, metrics: { ...mono.metrics, mdInlineCodeScale: 0.5 } },
  codeTight: { ...mono, metrics: { ...mono.metrics, mdInlineCodePaddingX: 0 } },
  codePad: { ...mono, metrics: { ...mono.metrics, mdInlineCodePaddingX: CODE_PAD } },
  bullet: {
    ...mono,
    listBullet: '•',
    listMarker: BULLET.color,
    metrics: { ...mono.metrics, mdListMarkerWidth: BULLET.width, mdListMarkerGap: BULLET.gap }
  },
  table: {
    ...mono,
    tableHeaderBg: TABLE_HEADER_FILL,
    metrics: {
      mdTextSize: 16,
      mdLineHeight: 44,
      mdTableCellPadding: 4,
      mdTableCellPaddingY: TABLE.padY,
      mdTableLineHeight: TABLE.lineHeight
    }
  }
}
const SOURCES: Record<MarkdownSample, string> = {
  link: '[lllllll](https://x.dev)',
  codeFull: '`MMMMMMM`',
  codeHalf: '`MMMMMMM`',
  codeTight: 'M`M`M',
  codePad: 'M`M`M',
  table: '| A | B |\n|---|---|\n| c | d |',
  bullet: '- M'
}

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
      const native = renderer as {
        getNativeWindowHandle?(): { kind: string; id?: number | null } | null
        getAllText?(): string[]
        getAutomationTree?(): string
      }
      const handle = native.getNativeWindowHandle?.()
      writeFileSync(
        `${readyFile}.tmp`,
        JSON.stringify({
          bounds,
          handle: handle ?? null,
          pid: process.pid,
          allText: native.getAllText?.() ?? [],
          tree: JSON.parse(native.getAutomationTree?.() ?? 'null')
        })
      )
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
    <div
      style={{ width: '100%', height: '100%', backgroundColor: '#000000', flexDirection: 'column' }}
    >
      <div style={{ flexDirection: 'row' }}>
        {box('upright', <text style={glyphs}>|||||||</text>)}
        {box('italic', <text style={{ ...glyphs, fontStyle: 'italic' }}>|||||||</text>)}
      </div>
      {(['link', 'codeFull', 'codeHalf'] as const).map((sample) =>
        box(sample, <markdown source={SOURCES[sample]} theme={THEMES[sample]} />)
      )}
      <div style={{ flexDirection: 'row' }}>
        {(['codeTight', 'codePad'] as const).map((sample) =>
          box(sample, <markdown source={SOURCES[sample]} theme={THEMES[sample]} />)
        )}
        {box(
          'table',
          <div style={{ width: 160 }}>
            <markdown source={SOURCES.table} theme={THEMES.table} />
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: GRID.columns, width: GRID.width }}>
        <div
          ref={(node: PublicInstance | null) => {
            refs.current.gridSpan = node
          }}
          style={{ gridColumnSpan: GRID.span, height: 8, backgroundColor: '#00ff00' }}
        />
        <div style={{ height: 8, backgroundColor: '#0000ff' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'row' }}>
        {(['untracked', 'tracked'] as const).map((sample) =>
          box(
            sample,
            <text
              style={{
                fontFamily: 'Paper Mono',
                fontSize: TRACKING.size,
                color: '#ffffff',
                ...(sample === 'tracked' ? { letterSpacing: TRACKING.em } : {})
              }}
            >
              {'M'.repeat(TRACKING.glyphs)}
            </text>
          )
        )}
        {box(
          'bullet',
          <div style={{ width: 160 }}>
            <markdown source={SOURCES.bullet} theme={THEMES.bullet} />
          </div>
        )}
      </div>
      {box(
        'input',
        <input
          value={url}
          style={{
            width: 240,
            height: 40,
            fontFamily: 'Paper Mono',
            fontSize: 28,
            color: '#ffffff'
          }}
        />
      )}
      {box(
        'blur',
        <div
          style={{ display: 'flex', width: BLUR.width, height: BLUR.height, flexDirection: 'row' }}
        >
          {Array.from({ length: BLUR.width / BLUR.stripe }, (_, i) => (
            <div
              key={i}
              style={{
                width: BLUR.stripe,
                height: BLUR.height,
                backgroundColor: i % 2 ? '#000000' : '#ffffff'
              }}
            />
          ))}
          <div
            style={{
              position: 'absolute',
              left: BLUR.width / 2,
              top: 0,
              width: BLUR.width / 2,
              height: BLUR.height,
              borderRadius: BLUR.radius,
              backdropBlur: BLUR.sigma
            }}
          />
        </div>
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
