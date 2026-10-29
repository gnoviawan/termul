/**
 * Row ids for settings search jumps. A row's DOM id is `setting-<key>`; its
 * control's id is `<key>` (the row label's `htmlFor`).
 */
export const rowId = (key: string): string => `setting-${key}`
