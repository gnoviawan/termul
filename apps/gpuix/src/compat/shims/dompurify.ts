/**
 * `dompurify` for shared code. DOMPurify parses through a live DOM, which
 * GPUIX does not have, so `sanitize` fails closed and returns an empty
 * string. Its callers feed `dangerouslySetInnerHTML`, which compat does not
 * render either; native overrides draw SVG and markdown from the source.
 */

import { compatWarn } from '../log'

function sanitize(_dirty: unknown, _config?: unknown): string {
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
