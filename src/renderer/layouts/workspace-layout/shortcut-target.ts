export function getShortcutTargetContext(target: EventTarget | null): {
  isInEditor: boolean
  isInTerminal: boolean
  isInInput: boolean
} {
  const element = target instanceof HTMLElement ? target : document.body
  const isInEditor = !!(element.closest('.cm-content') || element.closest('.bn-editor'))
  const isInTerminal = !!element.closest('.xterm')
  const isInInput =
    !isInTerminal &&
    (element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.isContentEditable ||
      !!element.closest('[contenteditable="true"]'))

  return { isInEditor, isInTerminal, isInInput }
}
