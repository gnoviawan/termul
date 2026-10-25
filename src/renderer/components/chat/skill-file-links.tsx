import { createContext, useCallback, useContext } from 'react'
import { toast } from 'sonner'
import { type SkillFileIndex, skillIndexKey, useSkillFileIndex } from '@/hooks/use-skill-file-index'
import { logFrontendError } from '@/lib/log-api'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CommandChip } from './CommandChip'
import { SkillChip } from './SkillChip'

/**
 * Clickable skill chips. A `SkillFilesProvider` indexes the `SKILL.md` files
 * visible from a project root; the chip links below look a name up in that
 * index and, on a hit, render their chip as a button that opens the file in
 * an editor tab. The file may live outside the project (`~/.agents/skills`,
 * `~/.config/opencode/skills`, ...) — the editor opens absolute paths.
 *
 * Without a provider every chip stays static.
 */
const SkillFileIndexContext = createContext<SkillFileIndex | null>(null)

export function SkillFilesProvider({
  projectRoot,
  children
}: {
  projectRoot: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  const index = useSkillFileIndex(projectRoot)
  return <SkillFileIndexContext.Provider value={index}>{children}</SkillFileIndexContext.Provider>
}

/** Prefix some harnesses use when they publish a skill as a command. */
const PROMOTED_SKILL_COMMAND_PREFIX = 'skill:'

function commandSkillName(command: string): string {
  return command.toLowerCase().startsWith(PROMOTED_SKILL_COMMAND_PREFIX)
    ? command.slice(PROMOTED_SKILL_COMMAND_PREFIX.length)
    : command
}

/**
 * The `SKILL.md` path for a chip, or `null` when the chip is not a known
 * skill. `knownPath` (captured at pick time in the composer) wins over the
 * index. A command resolves through its bare name or its `skill:` suffix.
 */
export function useSkillFilePath(
  name: string,
  options: { command?: boolean; knownPath?: string } = {}
): string | null {
  const index = useContext(SkillFileIndexContext)
  if (!index) return null
  if (options.knownPath) return options.knownPath
  const lookup = options.command ? commandSkillName(name) : name
  return index.get(skillIndexKey(lookup)) ?? null
}

/** Open a skill's `SKILL.md` in an editor tab. Failures toast and log. */
export async function openSkillFile(name: string, path: string): Promise<boolean> {
  try {
    await useEditorStore.getState().openFile(path)
    if (!useEditorStore.getState().openFiles.has(path)) {
      throw new Error('editor tab limit reached')
    }
    useWorkspaceStore.getState().addEditorTab(path)
    void logFrontendError({
      level: 'info',
      source: 'SkillFileLinks',
      message: `Opened skill '${name}' from chat: ${path}`
    })
    return true
  } catch (err) {
    toast.error(`Could not open SKILL.md for ${name}`)
    void logFrontendError({
      level: 'warn',
      source: 'SkillFileLinks',
      message: `Failed to open skill '${name}' at ${path}: ${err instanceof Error ? err.message : String(err)}`
    })
    return false
  }
}

/** Where a chip renders. In the composer the chip is not a tab stop (the
 * editor owns the keyboard). In a chat bubble a click that ends a text
 * selection over the chip does not open the file. */
type ChipSurface = 'composer' | 'bubble'

/** True when the user selected text that reaches the chip. A selection with
 * no text (the composer leaves one after select-all + delete) or a selection
 * elsewhere on the page must not block the click. */
function selectionTouches(chip: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return false
  if (selection.toString().length === 0) return false
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (selection.getRangeAt(i).intersectsNode(chip)) return true
  }
  return false
}

function useOpenHandler(
  name: string,
  path: string | null,
  surface: ChipSurface
): ((chip: HTMLElement) => void) | undefined {
  const open = useCallback(
    (chip: HTMLElement) => {
      if (!path) return
      if (surface === 'bubble' && selectionTouches(chip)) return
      void openSkillFile(name, path)
    },
    [name, path, surface]
  )
  return path ? open : undefined
}

export function SkillChipLink({
  name,
  path,
  surface
}: {
  name: string
  path?: string
  surface: ChipSurface
}): React.JSX.Element {
  const filePath = useSkillFilePath(name, { knownPath: path })
  const onOpen = useOpenHandler(name, filePath, surface)
  return (
    <SkillChip name={name} onOpen={onOpen} tabIndex={surface === 'composer' ? -1 : undefined} />
  )
}

export function CommandChipLink({
  name,
  surface
}: {
  name: string
  surface: ChipSurface
}): React.JSX.Element {
  const filePath = useSkillFilePath(name, { command: true })
  const onOpen = useOpenHandler(commandSkillName(name), filePath, surface)
  return (
    <CommandChip name={name} onOpen={onOpen} tabIndex={surface === 'composer' ? -1 : undefined} />
  )
}
