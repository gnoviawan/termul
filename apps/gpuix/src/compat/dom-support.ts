/**
 * What the compat layer implements of the DOM surface shared components touch.
 * `tools/compat/lint.ts` reads this table: a shared file that uses a `none`
 * entry must be on the override allowlist (`tools/compat/overrides.json`).
 * Keep it in step with `src/env/dom.ts` and `src/compat/dom-node.ts`.
 */

export type Support = 'full' | 'partial' | 'none'

export interface DomApi {
  id: string
  /**
   * Matched against source with comments blanked. Strings are blanked too,
   * except for a pattern whose source contains a quote (it names an event).
   */
  pattern: RegExp
  support: Support
  note: string
}

export const DOM_APIS: readonly DomApi[] = [
  { id: 'getBoundingClientRect', pattern: /\bgetBoundingClientRect\b/g, support: 'full', note: 'getElementBounds, last painted frame' },
  { id: 'scrollIntoView', pattern: /\bscrollIntoView\b/g, support: 'full', note: 'renderer.scrollIntoView' },
  { id: 'focus()', pattern: /\.focus\(/g, support: 'full', note: 'renderer.focusElement' },
  { id: 'blur()', pattern: /\.blur\(/g, support: 'full', note: 'renderer.blur when focused' },
  { id: 'contains()', pattern: /\.contains\(/g, support: 'full', note: 'tree mirror from getAutomationTree' },
  { id: 'dom-query', pattern: /\.closest\(|\bquerySelector(All)?\(|\bgetElementById\(/g, support: 'partial', note: 'tag, #id, .class, [attr], [attr=v], :not(), lists, descendant and child combinators; untracked elements answer as div' },
  { id: 'scroll-offset', pattern: /\b(scrollTop|scrollLeft)\b/g, support: 'full', note: 'getScrollOffset / scrollTo' },
  { id: 'scroll-size', pattern: /\b(scrollHeight|scrollWidth)\b/g, support: 'partial', note: 'children bounds extent' },
  { id: 'scroll-method', pattern: /\.scroll(To|By)\(/g, support: 'full', note: 'renderer.scrollTo' },
  { id: 'createPortal', pattern: /\bcreatePortal\b/g, support: 'full', note: 'react-dom shim -> GPUIX portal into the overlay root' },
  { id: 'flushSync', pattern: /\bflushSync\b/g, support: 'full', note: 'GPUIX flushSync' },
  { id: 'ResizeObserver', pattern: /\bResizeObserver\b/g, support: 'full', note: 'onLayout on ref-carrying elements' },
  { id: 'requestAnimationFrame', pattern: /\brequestAnimationFrame\b/g, support: 'full', note: '16 ms timer' },
  { id: 'matchMedia', pattern: /\bmatchMedia\b/g, support: 'full', note: 'width/height/hover/pointer/scheme/motion evaluator' },
  { id: 'focusin', pattern: /['"]focus(in|out)['"]/g, support: 'full', note: 'document focusin/focusout from element focus events' },
  { id: 'activeElement', pattern: /\bactiveElement\b/g, support: 'full', note: 'getFocusedElementId' },
  { id: 'window-key', pattern: /\b(window|document)\.addEventListener\(\s*['"]key(down|up)['"]/g, support: 'full', note: 'render({ onKeyDown, onKeyUp })' },
  { id: 'IntersectionObserver', pattern: /\bIntersectionObserver\b/g, support: 'none', note: 'no-op stub: never reports' },
  { id: 'MutationObserver', pattern: /\bMutationObserver\b/g, support: 'none', note: 'no-op stub: never reports' },
  { id: 'getComputedStyle', pattern: /\bgetComputedStyle\b/g, support: 'none', note: 'returns empty strings' },
  { id: 'element.addEventListener', pattern: /(?<!(?:window|document|globalThis|media|mql|query|socket|ws|source|controller|signal|transport|channel|worker|emitter|target|fonts|viewport|Viewport)\??)\??\.addEventListener\(\s*['"](?!message|open|close|error|change|abort|loadingdone|resize|scroll)/g, support: 'none', note: 'element listeners are not wired; use JSX handlers' },
  { id: 'text-selection', pattern: /\b(selectionStart|selectionEnd|setSelectionRange|getSelection)\b/g, support: 'none', note: 'GPUIX inputs expose no selection API' },
  { id: 'contentEditable', pattern: /\bcontentEditable\b/g, support: 'none', note: 'no editable host' },
  { id: 'dangerouslySetInnerHTML', pattern: /\bdangerouslySetInnerHTML\b/g, support: 'none', note: 'no HTML parser' },
  { id: 'html5-dnd', pattern: /\b(dataTransfer|DataTransfer|DragEvent|draggable|onDrop)\b/g, support: 'none', note: 'GPUIX has file drop only' },
  { id: 'execCommand', pattern: /\bexecCommand\b/g, support: 'none', note: 'no document editing' },
  { id: 'dom-create', pattern: /\bdocument\.create(Element|TextNode|Range|DocumentFragment)\b/g, support: 'none', note: 'no DOM nodes outside React' },
  { id: 'canvas-media', pattern: /<(canvas|video|iframe|webview)\b/g, support: 'none', note: 'no host element' },
  { id: 'element-style-write', pattern: /\.style\.[a-zA-Z]+\s*=(?!=)|\.style\.setProperty\(/g, support: 'none', note: 'styles come from props only' }
]

/** DOM-bound packages: `none` needs an override, `shim` has a compat stand-in. */
export const DOM_LIBS: readonly { id: string; specifier: RegExp; support: 'shim' | 'none' }[] = [
  { id: 'xterm', specifier: /^@xterm\//, support: 'none' },
  { id: 'tiptap', specifier: /^@tiptap\//, support: 'none' },
  { id: 'blocknote', specifier: /^@blocknote\//, support: 'none' },
  { id: 'codemirror', specifier: /^@codemirror\//, support: 'none' },
  { id: 'mermaid', specifier: /^mermaid$|^@streamdown\/mermaid$/, support: 'none' },
  { id: 'react-virtuoso', specifier: /^react-virtuoso$/, support: 'none' },
  { id: 'tanstack-virtual', specifier: /^@tanstack\/react-virtual$/, support: 'none' },
  { id: 'react-resizable-panels', specifier: /^react-resizable-panels$/, support: 'none' },
  { id: 'radix', specifier: /^@radix-ui\//, support: 'shim' },
  { id: 'framer-motion', specifier: /^(framer-motion|motion)(\/|$)/, support: 'shim' },
  { id: 'cmdk', specifier: /^cmdk$/, support: 'shim' },
  { id: 'react-dom', specifier: /^react-dom(\/|$)/, support: 'shim' },
  { id: 'sonner', specifier: /^sonner$/, support: 'shim' }
]
