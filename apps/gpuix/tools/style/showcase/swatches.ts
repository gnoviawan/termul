/**
 * Real Termul class strings laid out in fixed cells, rendered once by
 * Chromium with the renderer's CSS and once by GPUIX through tw().
 * Sources: components/ui/button.tsx, badge.tsx, input.tsx, kbd.tsx,
 * sidebar/project-item.tsx, sidebar/project-list.tsx, ssh/SSHConnectionPanel.tsx.
 */
export interface SwatchNode {
  tag?: 'div' | 'input'
  classes: string
  text?: string
  children?: SwatchNode[]
}

export interface Swatch {
  id: string
  /** Cell surface classes; the cell itself is a fixed, centred box. */
  surface: string
  /** Fixed width of the wrapper around the node, for w-full content. */
  width?: number
  node: SwatchNode
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0'
const PRIMARY_EMBOSS =
  'bg-primary-fill text-primary-foreground active:scale-[0.96] motion-reduce:active:scale-100 transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[color-mix(in_oklch,oklch(var(--primary-fill))_85%,black)] disabled:bg-muted disabled:text-disabled-foreground disabled:opacity-100 disabled:hover:bg-muted disabled:shadow-none shadow-[0_1px_2px_oklch(0_0_0/0.22),0_4px_8px_oklch(0_0_0/0.16),inset_0_1px_0_oklch(1_0_0/0.28),inset_0_-1px_1px_oklch(0_0_0/0.16)] hover:shadow-[0_1px_2px_oklch(0_0_0/0.26),0_5px_10px_oklch(0_0_0/0.2),inset_0_1px_0_oklch(1_0_0/0.34),inset_0_-1px_1px_oklch(0_0_0/0.2)]'
const BADGE_BASE =
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
const ROW =
  'group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs rounded-lg gap-2 px-2 transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
const ICON_BOX = 'inline-flex size-4 shrink-0 items-center justify-center'

const button = (variant: string, size: string, text: string): SwatchNode => ({
  classes: `${BUTTON_BASE} ${variant} ${size}`,
  text
})
const badge = (variant: string, text: string): SwatchNode => ({
  classes: `${BADGE_BASE} ${variant}`,
  text
})
const row = (active: boolean, name: string): SwatchNode => ({
  classes: `${ROW} ${active ? 'keycap text-foreground' : 'hover:bg-row-hover focus-within:bg-row-hover'}`,
  children: [
    { classes: ICON_BOX, children: [{ classes: 'size-2 rounded-full bg-success' }] },
    {
      classes: 'relative flex min-w-0 flex-1 items-center gap-2',
      children: [
        {
          classes: `min-w-0 flex-1 truncate font-medium transition-colors duration-150 ease-out ${
            active ? 'text-foreground' : 'text-secondary-foreground group-hover:text-foreground'
          }`,
          text: name
        }
      ]
    }
  ]
})

export const SWATCHES: Swatch[] = [
  {
    id: 'button-default',
    surface: 'bg-background',
    node: button(PRIMARY_EMBOSS, 'h-10 px-4 py-2', 'Save changes')
  },
  {
    id: 'button-outline',
    surface: 'bg-background',
    node: button(
      'border border-input bg-background hover:bg-secondary hover:text-accent-foreground',
      'h-10 px-4 py-2',
      'Cancel'
    )
  },
  {
    id: 'button-secondary',
    surface: 'bg-background',
    node: button(
      'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      'h-9 rounded-lg px-3',
      'Secondary'
    )
  },
  {
    id: 'button-ghost',
    surface: 'bg-card',
    node: button('hover:bg-secondary hover:text-accent-foreground', 'h-9 rounded-lg px-3', 'Ghost')
  },
  {
    id: 'button-destructive',
    surface: 'bg-background',
    node: button(
      'bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90',
      'h-10 px-4 py-2',
      'Delete'
    )
  },
  {
    id: 'button-xs',
    surface: 'bg-background',
    node: button(
      'border border-input bg-background hover:bg-secondary hover:text-accent-foreground',
      'h-7 rounded-md px-2 text-xs',
      'Small'
    )
  },
  {
    id: 'badge-default',
    surface: 'bg-background',
    node: badge(
      'border-transparent bg-primary-fill text-primary-foreground hover:bg-primary-fill/80',
      'Running'
    )
  },
  {
    id: 'badge-secondary',
    surface: 'bg-background',
    node: badge(
      'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
      'Idle'
    )
  },
  { id: 'badge-outline', surface: 'bg-background', node: badge('text-foreground', 'v0.4.50') },
  {
    id: 'input',
    surface: 'bg-background',
    width: 260,
    node: {
      tag: 'input',
      classes:
        'flex h-10 w-full rounded-lg border border-field-border bg-background px-3 py-2 text-base transition-colors duration-150 ease-out file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm pointer-coarse:text-base focus-visible:outline-hidden focus-visible:border-ring',
      text: 'termul-server'
    }
  },
  {
    id: 'card',
    surface: 'bg-background',
    width: 260,
    node: {
      classes: 'w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-5',
      children: [
        { classes: 'text-sm font-medium', text: 'SSH connection' },
        { classes: 'text-xs text-muted-foreground', text: 'deploy@build-01:22' }
      ]
    }
  },
  { id: 'sidebar-row-active', surface: 'bg-sidebar', width: 240, node: row(true, 'termul') },
  { id: 'sidebar-row-idle', surface: 'bg-sidebar', width: 240, node: row(false, 'gpuix-research') },
  {
    id: 'label-panel-row',
    surface: 'bg-sidebar',
    width: 240,
    node: {
      classes:
        'label-panel flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent',
      text: 'Archived projects'
    }
  },
  {
    id: 'muted-text',
    surface: 'bg-background',
    node: {
      classes: 'flex flex-col items-center justify-center p-6 text-center',
      children: [
        { classes: 'text-sm text-muted-foreground', text: 'No projects yet' },
        { classes: 'text-xs text-muted-foreground mt-1', text: 'Open a folder to start' }
      ]
    }
  },
  {
    id: 'kbd',
    surface: 'bg-background',
    node: {
      classes:
        'rounded border border-border font-sans text-3xs font-medium text-muted-foreground px-1.5',
      text: 'Ctrl K'
    }
  }
]

export const CELL = { width: 300, height: 180, gap: 15, left: 20, top: 20, columns: 4 }

export function cellRect(index: number): { x: number; y: number; width: number; height: number } {
  const col = index % CELL.columns
  const line = Math.floor(index / CELL.columns)
  return {
    x: CELL.left + col * (CELL.width + CELL.gap),
    y: CELL.top + line * (CELL.height + CELL.gap),
    width: CELL.width,
    height: CELL.height
  }
}

export function allClasses(): Set<string> {
  const out = new Set<string>()
  const walk = (node: SwatchNode) => {
    for (const c of node.classes.split(/\s+/)) if (c) out.add(c)
    node.children?.forEach(walk)
  }
  for (const s of SWATCHES) {
    walk(s.node)
    for (const c of s.surface.split(/\s+/)) out.add(c)
  }
  for (const c of ['bg-background', 'text-foreground', 'font-sans', 'antialiased', 'dark'])
    out.add(c)
  return out
}
