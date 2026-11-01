import { useEffect, useState } from 'react'
import { TERMINAL_LINE_HEIGHT } from '@/components/terminal/terminal-config'
import { terminalApi } from '@/lib/api'
import { useBindSessionClient } from '@/lib/command-lifecycle/bind-session'
import { useTerminalFontSize } from '@/stores/app-settings-store'
import { type CommandEditorProps, useCommandEditorView } from './use-command-editor'

/** Touch surfaces keep a 16px floor: parity with the `pointer-coarse:text-base`
 * input sizing used across the app (rail rows, panel fields, command bars). */
const TOUCH_MIN_FONT_SIZE = 16

function prefersCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

/** Live coarse-pointer subscription: like the CSS `pointer-coarse:` variant,
 * the touch font floor reacts to pointer changes (tablet mode, detachable
 * keyboards) without a remount. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(prefersCoarsePointer)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(pointer: coarse)')
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return coarse
}

/** Command editor font size in px: the terminal's font size, floored on
 * coarse-pointer (touch) devices where 13-14px mono text is hard to hit. */
export function commandEditorFontSize(
  terminalFontSize: number,
  coarsePointer: boolean = prefersCoarsePointer()
): number {
  return coarsePointer ? Math.max(terminalFontSize, TOUCH_MIN_FONT_SIZE) : terminalFontSize
}

export function CommandEditor(props: CommandEditorProps) {
  const binder = useBindSessionClient({
    host: terminalApi,
    scheduler: props.scheduler,
    terminalId: props.terminalId,
    ptyId: props.ptyId ?? (() => null),
    terminalName: props.terminalName,
    projectId: props.projectId
  })
  const containerRef = useCommandEditorView({ ...props, binder })
  // Sync with the terminal's font size instead of a static text-sm: the editor
  // sits on the terminal surface, so both must scale together. CodeMirror
  // caches text metrics — remeasure when the size changes.
  const terminalFontSize = useTerminalFontSize()
  const coarsePointer = useCoarsePointer()
  const editorFontSize = commandEditorFontSize(terminalFontSize, coarsePointer)
  // biome-ignore lint/correctness/useExhaustiveDependencies: editorFontSize is the change trigger that schedules a remeasure, not a value the effect reads.
  useEffect(() => {
    props.viewRef.current?.requestMeasure()
  }, [editorFontSize, props.viewRef])
  return (
    <div
      ref={containerRef}
      data-terminal-id={props.terminalId}
      style={{ fontSize: `${editorFontSize}px`, lineHeight: TERMINAL_LINE_HEIGHT }}
      className="shrink-0 p-2 font-mono text-foreground"
    />
  )
}
