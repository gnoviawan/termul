/** Difference sentences more than one review repeats. */

export const LAMP =
  'The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher.'

export const TITLE_TIP =
  'A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame.'
export const TEXTAREA_LINE =
  "The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does)."
export const BLUR =
  'The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005).'
export const CONFIRM_Z =
  'The web paints the workspace status bar sharp above the confirm scrim: ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling, so DOM order puts the bar on top. GPUIX puts the fixed overlay above everything, so the bar is dimmed and blurred with the rest.'
export const PROSE =
  "Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). One prose difference remains: a paragraph holding inline code breaks its lines at different words. G7 traced it to `text-wrap: pretty` on `.chat-streamdown`: Chromium rebalances a paragraph's last lines to avoid a short final line (the web's three lines end at 1198, 1175 and 739 px, GPUIX's greedy lines at 1261, 1220 and 660 px), and native markdown wraps greedily."
export const RUN_ORDER =
  'The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server.'
export const TREE_TEXT =
  'The text check fails only because natively painted text is not in the automation tree.'
export const SELECT =
  'Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px.'
export const DIVIDERS =
  'Rows inside a settings group have no divider lines and sit about 5 px tighter: SettingsGroup separates its rows with `divide-y divide-border`, and the GPUIX style layer has no `divide-*` utilities.'
export const SETTINGS_BASE = [
  'The section content and navigation match.',
  'The scrim dims and blurs the page behind it as on the web (N2).'
]
export const FIELD_FOCUS =
  "The focused field shows its caret, or nothing, but not the web's focus border (`focus-visible:border-ring`). G5 recorded that border in GPUIX, so this is a regression since G5. A candidate cause, not traced: gpui applies a `focus_visible` style only while the last input was the keyboard (`last_input_was_keyboard()` in its div.rs), and Chromium matches `:focus-visible` on any focused text field."
export const BAND_FOCUS =
  "The popover's search band keeps its plain hairline where the web turns it `ring` while the field has focus (`focus-within:border-ring`, BAND_FOCUS_CLASS)."
export const TOAST =
  'The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual.'
export const COMPOSER_FOCUS =
  'The web composer shows its focus border and ring while it holds the caret; GPUIX shows the caret with the resting border.'
export const COMPOSER_PICK =
  'After the switch the GPUIX beta composer was not ready when the frame was grabbed in 3 of 3 runs (Composer unavailable once, Loading model… twice), where the web composer already showed Chat Scenario Agent. palette.switch-project shows the same in 2 of 3 runs.'
