/**
 * `@streamdown/mermaid` without mermaid. Mermaid renders through an SVG DOM
 * and its ESM chunks fail to evaluate under Bun's bundler (ReferenceError
 * `adjust` at load, measured); diagrams need a native override. A fence
 * renders as the plugin's error state.
 */

import { compatWarn } from '../log'

export interface DiagramPlugin {
  name: 'mermaid'
  type: 'diagram'
  language: string
  getMermaid: () => { initialize(): void; render(id: string, source: string): Promise<{ svg: string }> }
}

export function createMermaidPlugin(): DiagramPlugin {
  return {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid: () => ({
      initialize() {},
      render() {
        compatWarn('lib-unsupported', 'mermaid diagram')
        return Promise.reject(new Error('mermaid is not available in the GPUIX client'))
      }
    })
  }
}

export const mermaid = createMermaidPlugin()
