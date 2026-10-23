/**
 * cmdk stand-in with cmdk's behaviour: the input filters items by `value`
 * (and `keywords`), groups and `Empty` show by what is left, the first item is
 * selected and Arrow keys / Enter move and run the selection.
 *
 * Parts are styled by cmdk's attribute selectors on an ancestor
 * (`[&_[cmdk-group-heading]]:text-xs` on `Command` or `Command.Group`). Compat
 * has no descendant selectors, so the root and groups hand those classes to
 * the parts through context and each part adds them to its own className.
 */
import {
  createContext,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

// biome-ignore lint/suspicious/noExplicitAny: a cmdk stand-in passes arbitrary DOM props through
type AnyProps = { children?: ReactNode; [prop: string]: any }

type Part = 'group-heading' | 'group' | 'group-items' | 'item' | 'input' | 'list' | 'empty' | 'separator'
type PartClasses = Partial<Record<Part, string>>

const PART_VARIANT = /^\[&_\[cmdk-([a-z-]+)\]\]:(.+)$/

/** Split `[&_[cmdk-x]]:cls` tokens out of a className: the element keeps the rest. */
export function splitPartClasses(className: string | undefined): { own: string; parts: PartClasses } {
  const own: string[] = []
  const parts: PartClasses = {}
  for (const token of (className ?? '').split(/\s+/).filter(Boolean)) {
    const match = token.match(PART_VARIANT)
    if (!match) {
      own.push(token)
      continue
    }
    const part = match[1] as Part
    parts[part] = parts[part] ? `${parts[part]} ${match[2]}` : match[2]
  }
  return { own: own.join(' '), parts }
}

const join = (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' ')

/** cmdk's ranking, reduced to what decides visibility: substring, then in-order letters. */
export function defaultFilter(value: string, search: string, keywords: readonly string[] = []): number {
  const haystack = `${value} ${keywords.join(' ')}`.toLowerCase()
  const needle = search.trim().toLowerCase()
  if (!needle || haystack.includes(needle)) return 1
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at < 0) return 0
    at++
  }
  return 0.5
}

interface ItemEntry {
  value: string
  keywords: readonly string[]
  group: string | null
  disabled: boolean
  order: number
  onSelect(): void
}

interface Snapshot {
  search: string
  selected: string | null
  /** Ids of the items that pass the filter, in mount order. */
  visible: readonly string[]
  /** Ids of the groups with a visible item. */
  groups: ReadonlySet<string>
}

interface StoreOptions {
  shouldFilter: boolean
  filter: typeof defaultFilter
  loop: boolean
  onValueChange?: (value: string) => void
}

class CommandStore {
  private readonly items = new Map<string, ItemEntry>()
  private readonly listeners = new Set<() => void>()
  private nextOrder = 0
  private search = ''
  private wanted: string | null = null
  private snapshot: Snapshot = { search: '', selected: null, visible: [], groups: new Set() }

  constructor(private readonly options: () => StoreOptions) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.snapshot

  register(id: string, entry: Omit<ItemEntry, 'order'>): () => void {
    this.items.set(id, { ...entry, order: this.items.get(id)?.order ?? this.nextOrder++ })
    this.update()
    return () => {
      this.items.delete(id)
      this.update()
    }
  }

  setSearch(search: string): void {
    if (search === this.search) return
    this.search = search
    this.wanted = null
    this.update()
  }

  select(value: string): void {
    if (value === this.snapshot.selected) return
    this.wanted = value
    this.update()
    this.options().onValueChange?.(value)
  }

  move(delta: 1 | -1): void {
    const values = this.enabled().map((entry) => entry.value)
    if (values.length === 0) return
    const at = values.indexOf(this.snapshot.selected ?? '')
    let next = at < 0 ? 0 : at + delta
    if (next < 0) next = this.options().loop ? values.length - 1 : 0
    if (next >= values.length) next = this.options().loop ? 0 : values.length - 1
    this.select(values[next])
  }

  runSelected(): void {
    this.enabled()
      .find((entry) => entry.value === this.snapshot.selected)
      ?.onSelect()
  }

  private enabled(): ItemEntry[] {
    return this.snapshot.visible.flatMap((id) => {
      const entry = this.items.get(id)
      return entry && !entry.disabled ? [entry] : []
    })
  }

  private update(): void {
    const { shouldFilter, filter } = this.options()
    const visible = [...this.items.entries()]
      .filter(([, item]) => !shouldFilter || !this.search || filter(item.value, this.search, item.keywords) > 0)
      .sort(([, a], [, b]) => a.order - b.order)
    const values = visible.filter(([, item]) => !item.disabled).map(([, item]) => item.value)
    const selected = this.wanted !== null && values.includes(this.wanted) ? this.wanted : (values[0] ?? null)
    const ids = visible.map(([id]) => id)
    const prev = this.snapshot
    if (prev.search === this.search && prev.selected === selected && prev.visible.join('\n') === ids.join('\n')) return
    const groups = new Set(visible.flatMap(([, item]) => (item.group ? [item.group] : [])))
    this.snapshot = { search: this.search, selected, visible: ids, groups }
    for (const listener of this.listeners) listener()
  }
}

interface RootContext {
  store: CommandStore
  parts: PartClasses
  search: string
  setSearch(value: string): void
}

const RootCtx = createContext<RootContext | null>(null)
const GroupCtx = createContext<{ id: string; parts: PartClasses } | null>(null)

function useRoot(part: string): RootContext {
  const ctx = useContext(RootCtx)
  if (!ctx) throw new Error(`compat cmdk: <${part}> outside <Command>`)
  return ctx
}

function useSnapshot(store: CommandStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * Part classes from the nearest group, then the root. Both selectors have the
 * same specificity, so on the web Tailwind's utility order decides; for the
 * classes Termul passes (`py-1.5` on groups, `pt-2`/`px-2.5` on the palette)
 * that is the root's, which comes last here.
 */
function usePartClass(root: RootContext, part: Part): string | undefined {
  const group = useContext(GroupCtx)
  return join(group?.parts[part], root.parts[part]) || undefined
}

const CommandRoot = forwardRef<HTMLDivElement, AnyProps>(function Command(
  {
    children,
    className,
    value: _value,
    onValueChange,
    shouldFilter = true,
    filter,
    loop = false,
    vimBindings: _vimBindings,
    label: _label,
    onKeyDown,
    ...props
  },
  ref
) {
  const optionsRef = useRef<StoreOptions>({ shouldFilter, filter: filter ?? defaultFilter, loop, onValueChange })
  optionsRef.current = { shouldFilter, filter: filter ?? defaultFilter, loop, onValueChange }
  const [store] = useState(() => new CommandStore(() => optionsRef.current))
  const [search, setSearchState] = useState('')
  const setSearch = useCallback(
    (next: string) => {
      setSearchState(next)
      store.setSearch(next)
    },
    [store]
  )
  const { own, parts } = useMemo(() => splitPartClasses(className), [className])
  const ctx = useMemo(() => ({ store, parts, search, setSearch }), [store, parts, search, setSearch])
  return (
    <RootCtx.Provider value={ctx}>
      <div
        ref={ref}
        cmdk-root=""
        className={own}
        onKeyDown={(event: { key: string; preventDefault(): void; defaultPrevented?: boolean }) => {
          onKeyDown?.(event)
          if (event.defaultPrevented) return
          if (event.key === 'ArrowDown') store.move(1)
          else if (event.key === 'ArrowUp') store.move(-1)
          else if (event.key === 'Enter') store.runSelected()
          else return
          event.preventDefault()
        }}
        {...props}
      >
        {children}
      </div>
    </RootCtx.Provider>
  )
})

const Input = forwardRef<HTMLInputElement, AnyProps>(function CommandInput(
  { className, value, onValueChange, onChange, ...props },
  ref
) {
  const root = useRoot('Command.Input')
  const controlled = typeof value === 'string'
  const { setSearch, search } = root
  useLayoutEffect(() => {
    if (controlled && value !== search) setSearch(value)
  }, [controlled, value, search, setSearch])
  return (
    <input
      ref={ref}
      cmdk-input=""
      className={join(className, root.parts.input)}
      value={controlled ? value : search}
      onChange={(event: { target: { value: string } }) => {
        onChange?.(event)
        const next = event.target.value
        if (!controlled) setSearch(next)
        onValueChange?.(next)
      }}
      {...props}
    />
  )
})

const List = forwardRef<HTMLDivElement, AnyProps>(function CommandList({ className, children, label: _label, ...props }, ref) {
  const root = useRoot('Command.List')
  return (
    <div ref={ref} cmdk-list="" role="listbox" className={join(className, root.parts.list)} {...props}>
      {children}
    </div>
  )
})

const Empty = forwardRef<HTMLDivElement, AnyProps>(function CommandEmpty({ className, children, ...props }, ref) {
  const root = useRoot('Command.Empty')
  const snapshot = useSnapshot(root.store)
  if (snapshot.visible.length > 0) return null
  return (
    <div ref={ref} cmdk-empty="" role="presentation" className={join(className, root.parts.empty)} {...props}>
      {children}
    </div>
  )
})

const Group = forwardRef<HTMLDivElement, AnyProps>(function CommandGroup(
  { className, heading, children, value: _value, forceMount, ...props },
  ref
) {
  const root = useRoot('Command.Group')
  const id = useId()
  const snapshot = useSnapshot(root.store)
  const { own, parts } = useMemo(() => splitPartClasses(className), [className])
  const group = useMemo(() => ({ id, parts }), [id, parts])
  const hidden = !forceMount && !snapshot.groups.has(id)
  // A group with nothing to show keeps its items mounted, so they stay
  // registered for the next search; compat skips the children of a
  // `display: none` element, so the group collapses to zero height instead.
  return (
    <GroupCtx.Provider value={group}>
      <div
        ref={ref}
        cmdk-group=""
        role="presentation"
        aria-hidden={hidden || undefined}
        className={hidden ? 'h-0 overflow-hidden' : join(own, root.parts.group)}
        {...props}
      >
        {heading && !hidden ? (
          <div cmdk-group-heading="" aria-hidden className={join(parts['group-heading'], root.parts['group-heading'])}>
            {heading}
          </div>
        ) : null}
        <div cmdk-group-items="" role="group" className={join(parts['group-items'], root.parts['group-items'])}>
          {children}
        </div>
      </div>
    </GroupCtx.Provider>
  )
})

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

const Item = forwardRef<HTMLDivElement, AnyProps>(function CommandItem(
  { className, value, keywords, disabled = false, onSelect, forceMount, children, onMouseMove, onClick, ...props },
  ref
) {
  const root = useRoot('Command.Item')
  const group = useContext(GroupCtx)
  const id = useId()
  const itemValue = (typeof value === 'string' ? value : textOf(children)).trim()
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const keywordKey = Array.isArray(keywords) ? keywords.join('\n') : ''
  const groupId = group?.id ?? null
  useLayoutEffect(
    () =>
      root.store.register(id, {
        value: itemValue,
        keywords: keywordKey ? keywordKey.split('\n') : [],
        group: groupId,
        disabled,
        onSelect: () => onSelectRef.current?.(itemValue)
      }),
    [root.store, id, itemValue, keywordKey, groupId, disabled]
  )
  const snapshot = useSnapshot(root.store)
  const itemClass = usePartClass(root, 'item')
  if (!forceMount && !snapshot.visible.includes(id)) return null
  const selected = snapshot.selected === itemValue
  return (
    <div
      ref={ref}
      cmdk-item=""
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      data-selected={selected ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
      data-value={itemValue}
      className={join(className, itemClass)}
      onMouseMove={(event: unknown) => {
        onMouseMove?.(event)
        if (!disabled) root.store.select(itemValue)
      }}
      onClick={(event: unknown) => {
        onClick?.(event)
        if (!disabled) onSelectRef.current?.(itemValue)
      }}
      {...props}
    >
      {children}
    </div>
  )
})

const Separator = forwardRef<HTMLDivElement, AnyProps>(function CommandSeparator(
  { className, alwaysRender, ...props },
  ref
) {
  const root = useRoot('Command.Separator')
  const snapshot = useSnapshot(root.store)
  if (!alwaysRender && snapshot.search && snapshot.visible.length === 0) return null
  return <div ref={ref} cmdk-separator="" role="separator" className={join(className, root.parts.separator)} {...props} />
})

const Loading = forwardRef<HTMLDivElement, AnyProps>(function CommandLoading(
  { children, progress: _progress, label: _label, ...props },
  ref
) {
  return (
    <div ref={ref} cmdk-loading="" role="progressbar" {...props}>
      {children}
    </div>
  )
})

export const Command = Object.assign(CommandRoot, { Input, List, Empty, Group, Item, Separator, Loading, Dialog: CommandRoot })
export const CommandInput = Input
export const CommandList = List
export const CommandEmpty = Empty
export const CommandGroup = Group
export const CommandItem = Item
export const CommandSeparator = Separator
export const CommandLoading = Loading

/** cmdk's `useCommandState(selector)` over the search, the selected value and the visible count. */
export function useCommandState<T>(
  selector: (state: { search: string; value: string | null; filtered: { count: number } }) => T
): T {
  const root = useRoot('useCommandState')
  const snapshot = useSnapshot(root.store)
  return selector({ search: snapshot.search, value: snapshot.selected, filtered: { count: snapshot.visible.length } })
}
