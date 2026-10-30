import { terminalApi } from '@/lib/api'
import { useBindSessionClient } from '@/lib/command-lifecycle/bind-session'
import { type CommandEditorProps, useCommandEditorView } from './use-command-editor'

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
  return (
    <div
      ref={containerRef}
      data-terminal-id={props.terminalId}
      className="shrink-0 p-2 font-mono text-sm pointer-coarse:text-base text-foreground"
    />
  )
}
