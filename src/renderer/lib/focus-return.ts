/**
 * Where focus should go back when an overlay closes: the element focused when
 * it opened — or, when that was an item in a Radix menu (which disappears with
 * its menu), the menu's trigger.
 */
export function captureFocusReturnTarget(): HTMLElement | null {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const menuTriggerId = opener?.closest('[role="menu"]')?.getAttribute('aria-labelledby')
  const trigger = menuTriggerId ? document.getElementById(menuTriggerId) : null
  return trigger ?? (opener === document.body ? null : opener)
}
