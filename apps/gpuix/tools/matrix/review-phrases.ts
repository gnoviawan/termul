/** Difference sentences more than one review repeats. */

export const LAMP =
  'The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored).'

export const TITLE_TIP =
  'A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame.'
export const CHECKBOX =
  'The Amend last commit checkbox box is not drawn (native checkbox input), only its label.'
export const BACKDROP =
  'The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable.'
export const PROSE =
  'Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge.'
export const RUN_ORDER =
  'The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server.'
export const TREE_TEXT =
  'The text check fails only because natively painted text is not in the automation tree.'
export const TINT =
  'Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have).'
export const SELECT =
  'Each select is one closed dropdown like the web (G2), but its trigger sizes to its value where the web gives it 240px (`@[35rem]:w-60`: container queries are not translated).'
export const TAB_TRUNC =
  'Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart.'
export const TAB_TITLE =
  'The GPUIX tab title truncates to a few letters ("matr...") where the web shows the whole title.'
export const SETTINGS_BASE = [
  'The section content and navigation match.',
  'The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp.',
  TINT
]
export const TOAST =
  'The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual.'
