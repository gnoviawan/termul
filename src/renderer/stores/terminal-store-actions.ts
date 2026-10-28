import { useShallow } from 'zustand/shallow'
import { type TerminalState, useTerminalStore } from './terminal-store'

export function useTerminalActions(): Pick<
  TerminalState,
  | 'selectTerminal'
  | 'addTerminal'
  | 'closeTerminal'
  | 'renameTerminal'
  | 'reorderTerminals'
  | 'updateTerminalCwd'
  | 'updateTerminalScrollback'
  | 'appendTranscript'
  | 'peekTranscript'
  | 'consumeTranscript'
  | 'appendDetachedOutput'
  | 'consumeDetachedOutput'
  | 'setRendererAttached'
  | 'setTerminalPtyId'
  | 'clearTerminalPtyId'
> {
  return useTerminalStore(
    useShallow((state) => ({
      selectTerminal: state.selectTerminal,
      addTerminal: state.addTerminal,
      closeTerminal: state.closeTerminal,
      renameTerminal: state.renameTerminal,
      reorderTerminals: state.reorderTerminals,
      updateTerminalCwd: state.updateTerminalCwd,
      updateTerminalScrollback: state.updateTerminalScrollback,
      appendTranscript: state.appendTranscript,
      peekTranscript: state.peekTranscript,
      consumeTranscript: state.consumeTranscript,
      appendDetachedOutput: state.appendDetachedOutput,
      consumeDetachedOutput: state.consumeDetachedOutput,
      setRendererAttached: state.setRendererAttached,
      setTerminalPtyId: state.setTerminalPtyId,
      clearTerminalPtyId: state.clearTerminalPtyId
    }))
  )
}
