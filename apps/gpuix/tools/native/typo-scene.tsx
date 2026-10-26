/**
 * The GPUIX half of `typo-check.ts`: the text samples of `typo-samples.ts` in
 * Inter, white on black, at fixed window positions. Writes each sample's
 * bounds to the ready file.
 *
 * bun tools/native/typo-scene.tsx <ready.json>
 */
import { renameSync, writeFileSync } from 'node:fs'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { transcriptThemes } from '../../src/chat/theme'
import { registerTermulFonts } from '../../src/style/fonts'
import {
  FAMILY,
  FULLSCREEN_TABLE_SAMPLE,
  MARKER_LINE,
  MARKER_SAMPLES,
  RULE_COLOR,
  TABLE_SAMPLE,
  TEXT_SAMPLES,
  TRANSCRIPT_RULE_COLOR,
  TYPO_WINDOW,
  tableMarkdown,
  WASH_COLOR,
  WASH_LEFT,
  WASH_SAMPLES
} from './typo-samples'

const [readyFile] = process.argv.slice(2)

function App() {
  const renderer = useGpuixRequired()
  const refs = useRef<Record<string, PublicInstance | null>>({})
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    registerTermulFonts(renderer)
    setFontsReady(true)
  }, [renderer])
  useEffect(() => {
    if (!fontsReady) return
    const timer = setTimeout(() => {
      const bounds = Object.fromEntries(
        [...TEXT_SAMPLES, TABLE_SAMPLE, FULLSCREEN_TABLE_SAMPLE].map((s) => {
          const node = refs.current[s.id]
          return [s.id, node ? renderer.getElementBounds?.(node.id) : null]
        })
      )
      writeFileSync(`${readyFile}.tmp`, JSON.stringify({ bounds }))
      renameSync(`${readyFile}.tmp`, readyFile as string)
    }, 800)
    return () => clearTimeout(timer)
  }, [renderer, fontsReady])
  if (!fontsReady) return null
  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#000000' }}>
      {TEXT_SAMPLES.map((s) => {
        const font = {
          fontFamily: FAMILY,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          color: '#ffffff'
        }
        return (
          <div
            key={s.id}
            ref={(node: PublicInstance | null) => {
              refs.current[s.id] = node
            }}
            style={{
              position: 'absolute',
              left: s.left,
              top: s.top,
              flexDirection: 'column',
              ...(s.width ? { width: s.width } : {})
            }}
          >
            {s.stack ? (
              Array.from({ length: s.stack }, (_, i) => (
                <text key={i} style={font}>
                  {s.text}
                </text>
              ))
            ) : (
              <text style={font}>{s.text}</text>
            )}
          </div>
        )
      })}
      <div
        ref={(node: PublicInstance | null) => {
          refs.current[TABLE_SAMPLE.id] = node
        }}
        style={{
          position: 'absolute',
          left: TABLE_SAMPLE.left,
          top: TABLE_SAMPLE.top,
          width: TABLE_SAMPLE.width,
          borderWidth: 1,
          borderColor: '#444444'
        }}
      >
        <markdown
          source={tableMarkdown()}
          theme={{ ...transcriptThemes('termul').prose, tableRule: TRANSCRIPT_RULE_COLOR }}
        />
      </div>
      <div
        ref={(node: PublicInstance | null) => {
          refs.current[FULLSCREEN_TABLE_SAMPLE.id] = node
        }}
        style={{
          position: 'absolute',
          left: FULLSCREEN_TABLE_SAMPLE.left,
          top: FULLSCREEN_TABLE_SAMPLE.top,
          width: FULLSCREEN_TABLE_SAMPLE.width,
          borderWidth: 1,
          borderColor: RULE_COLOR
        }}
      >
        <markdown
          source={tableMarkdown()}
          theme={{ ...transcriptThemes('termul').tableFullscreen, tableRule: RULE_COLOR }}
        />
      </div>
      {WASH_SAMPLES.map((s) => (
        <div
          key={s.id}
          style={{
            position: 'absolute',
            left: WASH_LEFT,
            top: s.top,
            width: TYPO_WINDOW.width - 32
          }}
        >
          <markdown
            source={s.text}
            theme={{
              ...transcriptThemes('termul')[s.theme],
              codeWash: WASH_COLOR
            }}
          />
        </div>
      ))}
      {MARKER_SAMPLES.map((s) => (
        <div key={s.id} style={{ position: 'absolute', left: s.left, top: s.top, width: 180 }}>
          <markdown
            source={`${s.n}\\. ${s.text}`}
            theme={{
              ...transcriptThemes('termul').orderedItem,
              metrics: { ...transcriptThemes('termul').orderedItem.metrics, mdLineHeight: MARKER_LINE }
            }}
          />
        </div>
      ))}
    </div>
  )
}

if (readyFile) {
  render(<App />, {
    title: 'termul-typo-check',
    width: TYPO_WINDOW.width,
    height: TYPO_WINDOW.height,
    focus: false
  })
}
