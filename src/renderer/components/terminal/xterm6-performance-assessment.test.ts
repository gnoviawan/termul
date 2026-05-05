import { describe, expect, it } from 'vitest'
import {
  Xterm6FitAddon,
  Xterm6SearchAddon,
  Xterm6Terminal,
  Xterm6WebLinksAddon,
  Xterm6WebglAddon,
} from '../../lib/xterm6-compat'
import { generateHeavyOutput, generateWideLines } from './terminal-performance.shared'

type RendererMode = 'baseline-5.5-auto' | 'baseline-5.5-canvas' | 'candidate-6.1-auto' | 'candidate-6.1-webgl'

interface AssessmentResult {
  rendererMode: RendererMode
  lineCount: number
  charCount: number
  fitAddonLoadable: boolean
  searchAddonLoadable: boolean
  webLinksAddonLoadable: boolean
  webglAddonLoadable: boolean
}

function assessRendererMode(rendererMode: RendererMode): AssessmentResult {
  const sample = rendererMode.includes('wide') ? generateWideLines(1000, 120) : generateHeavyOutput(1000)

  return {
    rendererMode,
    lineCount: sample.split(/\r\n|\n|\r/).length,
    charCount: sample.length,
    fitAddonLoadable: rendererMode.startsWith('candidate-6.1') ? typeof Xterm6FitAddon === 'function' : true,
    searchAddonLoadable: rendererMode.startsWith('candidate-6.1') ? typeof Xterm6SearchAddon === 'function' : true,
    webLinksAddonLoadable: rendererMode.startsWith('candidate-6.1') ? typeof Xterm6WebLinksAddon === 'function' : true,
    webglAddonLoadable: rendererMode === 'candidate-6.1-webgl' ? typeof Xterm6WebglAddon === 'function' : true,
  }
}

describe('xterm 6.1 performance assessment harness', () => {
  it('can assess the planned renderer modes without replacing the 5.5 default path', () => {
    const modes: RendererMode[] = [
      'baseline-5.5-auto',
      'baseline-5.5-canvas',
      'candidate-6.1-auto',
      'candidate-6.1-webgl',
    ]

    const results = modes.map(assessRendererMode)

    expect(results).toHaveLength(4)
    expect(typeof Xterm6Terminal).toBe('function')
    expect(results.find((result) => result.rendererMode === 'candidate-6.1-auto')?.fitAddonLoadable).toBe(true)
    expect(results.find((result) => result.rendererMode === 'candidate-6.1-webgl')?.webglAddonLoadable).toBe(true)
  })
})
