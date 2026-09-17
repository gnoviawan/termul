import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, type ButtonProps } from '../button'

/**
 * Regression tests for the `touch` button size (QA F1 touch-target floor):
 * a 44px visual (`h-11`) + `after:-inset-1.5` hit-slop pseudo-element so
 * mobile call sites get a ~48px tappable area without growing layout
 * chrome — the same idiom AttachFilesButton / ChatHistoryEntryRow hand-roll.
 *
 * Foundation only: no call site uses `touch` yet (stories 10/11/12 adopt
 * it). The regression bar is therefore "the floor exists and nothing else
 * moved": every pre-existing size renders byte-identical to the class
 * strings recorded before this variant was added.
 */

/** Render one Button and return its full rendered className string. */
function buttonClass(props: Partial<ButtonProps> = {}): string {
  const { unmount } = render(<Button {...props}>Label</Button>)
  const el = screen.getByRole('button')
  const className = el.className
  unmount()
  return className
}

// Matrix row 2 — verbatim rendered class strings recorded from the DOM
// (post `cn`/tailwind-merge) BEFORE `touch` existed. tailwind-merge drops
// base classes overridden by a size (e.g. xs's `text-xs`/`rounded-md`
// remove the base `text-sm`/`rounded-lg`), so these are NOT simple
// base+variant+size concatenations — treat them as frozen output. Any
// drift means desktop density moved, which this story must never do.
const PRE_EXISTING_SIZES: Record<string, string> = {
  default:
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2',
  xs: 'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-7 rounded-md px-2 text-xs',
  sm: 'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-9 rounded-lg px-3',
  lg: 'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-11 rounded-lg px-8',
  icon: 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-10',
  'icon-xs':
    'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-6 w-6 rounded-md',
  'icon-sm':
    'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-8 w-8 rounded-lg',
  'icon-lg':
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 h-10 w-10'
}

// The touch-only classes that must never leak into another size.
const TOUCH_CLASSES = ['relative', 'after:absolute', 'after:-inset-1.5', "after:content-['']"]

describe('Button size="touch" (44px touch-target floor)', () => {
  it('renders h-11 plus the hit-slop pseudo-element classes (matrix row 1)', () => {
    const className = buttonClass({ size: 'touch' })
    // Visual floor: 44px height.
    expect(className).toContain('h-11')
    // Hit-slop idiom: an out-of-flow ::after overlay extending 6px beyond
    // the box on every side, so the tappable area is ~48px while layout
    // stays 44px. `relative` anchors the overlay to the button box.
    expect(className).toContain('relative')
    expect(className).toContain('after:absolute')
    expect(className).toContain('after:-inset-1.5')
    expect(className).toContain("after:content-['']")
    // The overlay must not grow the button's own box.
    expect(className).not.toContain('w-11')
    expect(className).not.toContain('after:inset-')
  })

  it.each(
    Object.keys(PRE_EXISTING_SIZES)
  )('size="%s" is byte-identical to pre-change — no touch classes leak (matrix row 2)', (size) => {
    const className = buttonClass({ size: size as ButtonProps['size'] })
    // Byte-identical regression bar: the whole rendered class string
    // equals the recorded pre-change string.
    expect(className).toBe(PRE_EXISTING_SIZES[size])
    // Explicit legibility: none of the touch/hit-slop classes appear.
    for (const c of TOUCH_CLASSES) {
      expect(className).not.toContain(c)
    }
  })

  it.each([
    'default',
    'destructive',
    'outline',
    'secondary',
    'ghost',
    'link'
  ])('composes with variant="%s" — both variant and size classes apply (matrix row 3)', (variant) => {
    const className = buttonClass({
      size: 'touch',
      variant: variant as ButtonProps['variant']
    })
    // The touch floor applies unchanged alongside every variant's chrome.
    expect(className).toContain('h-11')
    expect(className).toContain('relative')
    expect(className).toContain('after:-inset-1.5')
    expect(className).toContain("after:content-['']")
    // And the variant's own classes survive the merge (no clobbering).
    const variantClasses: Record<string, string> = {
      default: 'bg-primary text-primary-foreground',
      destructive: 'bg-destructive text-destructive-foreground',
      outline: 'border border-input bg-background',
      secondary: 'bg-secondary text-secondary-foreground',
      ghost: 'hover:bg-secondary',
      link: 'text-primary underline-offset-4'
    }
    expect(className).toContain(variantClasses[variant])
  })

  it('hit-slop is non-visual: layout box stays 44px, only the pseudo-element extends (matrix row 4)', () => {
    const { unmount } = render(
      <div style={{ display: 'flex' }}>
        <Button size="touch" variant="ghost">
          A
        </Button>
        <Button size="touch" variant="ghost">
          B
        </Button>
      </div>
    )
    const [a, b] = screen.getAllByRole('button')
    // Layout sizing comes only from `h-11` — no padding/inset classes that
    // would push flex siblings apart; the row height stays the visual 44px.
    for (const el of [a, b]) {
      expect(el).toHaveClass('h-11')
      expect(el).toHaveClass('after:-inset-1.5')
      expect(el.className).not.toMatch(/\bp[xy]?-\d/)
      expect(el.className).not.toMatch(/after:inset-[0-9]/)
    }
    // jsdom has no layout engine; the contract that keeps the slop
    // non-visual is the overlay being out-of-flow (positioned), never an
    // in-flow box or padding.
    expect(a).toHaveClass('after:absolute')
    unmount()
  })
})
