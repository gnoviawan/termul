/**
 * `dompurify` for shared code. DOMPurify parses through a live DOM, which
 * GPUIX does not have. One case is served without it: an SVG icon
 * (`USE_PROFILES: { svg: true }`, the agent icons), which compat paints as a
 * GPUIX `<svg>`. GPUIX never runs script, so the markup passes when it is one
 * `<svg>` of shapes; anything that could pull in other content (scripts,
 * foreign objects, images, styles, event attributes, non-fragment links)
 * fails closed, as does every other call.
 */

import { compatWarn } from '../log'

interface Config {
  USE_PROFILES?: { svg?: boolean }
}

const ONE_SVG = /^\s*<svg[\s>][\s\S]*<\/svg>\s*$/i
const UNSAFE =
  /<(?:script|foreignObject|image|img|iframe|style|use|a)\b|\son[a-z]+\s*=|href\s*=\s*["']?(?!#)/i

/** An XML declaration, doctype or comment before the root, which DOMPurify drops too. */
const PROLOG = /^\s*(?:<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|\s)*/i

function sanitize(dirty: unknown, config?: Config): string {
  const markup = typeof dirty === 'string' ? dirty.replace(PROLOG, '') : ''
  if (config?.USE_PROFILES?.svg && ONE_SVG.test(markup) && !UNSAFE.test(markup))
    return markup.trim()
  compatWarn('library-stub', 'dompurify sanitize (fails closed)')
  return ''
}

const DOMPurify = {
  isSupported: false,
  sanitize,
  addHook(): void {},
  removeHook(): void {},
  removeAllHooks(): void {},
  setConfig(): void {},
  clearConfig(): void {}
}

export default DOMPurify
