/**
 * Context-strip menu colors (launcher only — the shared Select primitive is
 * untouched). Neutral fills with a wider L gap: rest text is solid muted,
 * hover/open/checked use the muted surface with foreground text.
 *
 * The trigger keeps the strip's slim 28px row but carries the app's standard
 * pseudo hit-extension (`AttachFilesButton` pattern): 28px visual + 6px per
 * side = the 40×40 desktop floor, without growing the chrome.
 */
export const STRIP_TRIGGER_CLASS =
  'relative h-7 min-h-7 w-auto shrink-0 gap-1.5 border-0 bg-transparent px-2.5 py-0 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:bg-muted data-[state=open]:text-foreground after:absolute after:-inset-1.5 after:content-[""] [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:opacity-70'
export const STRIP_MENU_ITEM_CLASS =
  'focus:bg-muted focus:text-foreground data-[state=checked]:bg-muted data-[state=checked]:text-foreground'
