/**
 * Type stand-in for the shared DOM component the scene mounts. Its real JSX
 * compiles against the compat runtime, which this GPUIX-typed program does not
 * check; the props are the subset the scene passes.
 */

import type { AvailableCommand, ContentBlock, SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store'

export interface ChatInputBarSceneProps {
  session: AcpSession
  busy: boolean
  disabled: boolean
  onSend: (text: string) => void
  onSendBlocks: (blocks: ContentBlock[], displayBlocks?: ContentBlock[]) => void
  onCancel: () => void
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  onSetMode: (modeId: string) => void | Promise<void>
  onSetModel: (modelId: string) => void | Promise<void>
  isVisible?: boolean
}

export declare function ChatInputBar(props: ChatInputBarSceneProps): React.ReactNode
