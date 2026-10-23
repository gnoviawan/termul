/**
 * The keyboard model Radix gives DropdownMenu, ContextMenu and Select, on a
 * virtual highlight: the content element holds focus and reads the keys, and
 * items register themselves in mount order.
 *
 * - Down / Up move the highlight, skipping disabled items, without wrapping (Radix `loop={false}`).
 * - Home / End jump to the first / last item.
 * - Enter / Space select the highlighted item.
 * - Printable keys typeahead: the next item whose text starts with what was typed within a second.
 * - Pointer movement highlights the item under it; leaving the content clears it.
 * - Opened from the keyboard, the first item (or the selected one, for Select) starts highlighted.
 */
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { UiKeyboardEvent } from './host'

export interface MenuItemRecord {
  key: number
  disabled: boolean
  textValue: string
  /** Value of a Select item, for "highlight the selected item on open". */
  value?: string
  select(): void
  /** Sub-menu triggers open on ArrowRight. */
  openSub?(): void
}

export interface MenuModel {
  highlighted: number | null
  highlight(key: number | null): void
  register(record: MenuItemRecord): () => void
  onKeyDown(event: UiKeyboardEvent): boolean
  highlightFirst(): void
  highlightValue(value: string | undefined): void
}

export const MenuContext = createContext<MenuModel | null>(null)

export function useMenu(part: string): MenuModel {
  const menu = useContext(MenuContext)
  if (!menu) throw new Error(`${part} must be inside a menu content`)
  return menu
}

const TYPEAHEAD_RESET_MS = 1000

export function useMenuModel(): MenuModel {
  const [highlighted, setHighlighted] = useState<number | null>(null)
  const items = useRef<MenuItemRecord[]>([])
  const current = useRef<number | null>(null)
  current.current = highlighted
  const typed = useRef({ text: '', at: 0 })

  const highlight = useCallback((key: number | null) => {
    current.current = key
    setHighlighted(key)
  }, [])

  // Built once: items register in mount order, so `register` must never change identity.
  const api = useMemo<Omit<MenuModel, 'highlighted'>>(() => {
    const enabled = () => items.current.filter((item) => !item.disabled)
    const indexOfCurrent = (list: MenuItemRecord[]) =>
      list.findIndex((item) => item.key === current.current)
    const move = (delta: 1 | -1) => {
      const list = enabled()
      if (list.length === 0) return
      const index = indexOfCurrent(list)
      if (index === -1) {
        highlight((delta === 1 ? list[0] : list[list.length - 1]).key)
        return
      }
      const next = Math.min(list.length - 1, Math.max(0, index + delta))
      highlight(list[next].key)
    }
    const typeahead = (char: string) => {
      const now = Date.now()
      typed.current.text =
        now - typed.current.at > TYPEAHEAD_RESET_MS ? char : typed.current.text + char
      typed.current.at = now
      const query = typed.current.text.toLowerCase()
      const list = enabled()
      const start = Math.max(0, indexOfCurrent(list))
      // A repeated single letter cycles, as in Radix: search after the current item.
      const from = query.length === 1 ? start + 1 : start
      const ordered = [...list.slice(from), ...list.slice(0, from)]
      const match = ordered.find((item) => item.textValue.toLowerCase().startsWith(query))
      if (match) highlight(match.key)
    }
    return {
      highlight,
      register(record) {
        items.current = [...items.current, record]
        return () => {
          items.current = items.current.filter((item) => item.key !== record.key)
          if (current.current === record.key) highlight(null)
        }
      },
      highlightFirst() {
        const first = enabled()[0]
        if (first) highlight(first.key)
      },
      highlightValue(value) {
        const match = enabled().find((item) => value !== undefined && item.value === value)
        const fallback = enabled()[0]
        if (match ?? fallback) highlight((match ?? fallback).key)
      },
      onKeyDown(event) {
        const active = items.current.find((item) => item.key === current.current)
        switch (event.key) {
          case 'ArrowDown':
            move(1)
            return true
          case 'ArrowUp':
            move(-1)
            return true
          case 'Home': {
            const first = enabled()[0]
            if (first) highlight(first.key)
            return true
          }
          case 'End': {
            const list = enabled()
            if (list.length > 0) highlight(list[list.length - 1].key)
            return true
          }
          case 'ArrowRight':
            if (active?.openSub) {
              active.openSub()
              return true
            }
            return false
          case 'Enter':
          case ' ':
            if (event.key === ' ' && Date.now() - typed.current.at < TYPEAHEAD_RESET_MS) {
              typeahead(' ')
              return true
            }
            if (active && !active.disabled) active.select()
            return true
          default:
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              typeahead(event.key)
              return true
            }
            return false
        }
      }
    }
  }, [highlight])
  return useMemo(() => ({ ...api, highlighted }), [api, highlighted])
}

let nextItemKey = 1

/** Register one item and keep its record current. Returns its key. */
export function useMenuItem(menu: MenuModel, record: Omit<MenuItemRecord, 'key'>): number {
  const key = useRef(0)
  if (key.current === 0) key.current = nextItemKey++
  const full = { ...record, key: key.current }
  const latest = useRef(full)
  latest.current = full
  const { register } = menu
  const hasSub = record.openSub !== undefined
  useLayoutEffect(
    () =>
      register({
        key: key.current,
        get disabled() {
          return latest.current.disabled
        },
        get textValue() {
          return latest.current.textValue
        },
        get value() {
          return latest.current.value
        },
        select: () => latest.current.select(),
        openSub: hasSub ? () => latest.current.openSub?.() : undefined
      }),
    [register, hasSub]
  )
  return key.current
}

/** The text of a node tree, for typeahead (Radix reads `textContent`). */
export function textOf(node: ReactNode): string {
  let out = ''
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') out += String(child)
    else if (isValidElement<{ children?: ReactNode }>(child)) out += textOf(child.props.children)
  })
  return out.trim()
}

/** DOM-like event handed to `onSelect`; `preventDefault()` keeps the menu open. */
export interface MenuSelectEvent {
  type: 'select'
  defaultPrevented: boolean
  preventDefault(): void
}

export function selectEvent(): MenuSelectEvent {
  const event: MenuSelectEvent = {
    type: 'select',
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    }
  }
  return event
}
