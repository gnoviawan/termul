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
  'The workspace status bar stays sharp above the confirm scrim, as on the web, where ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling (G9: compat gives the fixed overlay its z-index as its `<anchored>` priority, and native patch gpuix/0011 paints the `relative z-50` bar in the same deferred pass, after it in tree order; status-bar text 75 against the web\'s 72, dimmed to 11 before).'
export const PROSE =
  "Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). One prose difference remains: a paragraph holding inline code breaks its lines at different words. G7 traced it to `text-wrap: pretty` on `.chat-streamdown`: Chromium rebalances a paragraph's last lines to avoid a short final line (the web's three lines end at 1198, 1175 and 739 px, GPUIX's greedy lines at 1261, 1220 and 660 px), and native markdown wraps greedily."
export const RUN_ORDER =
  'The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server.'
export const TREE_TEXT =
  'The text check fails only because natively painted text is not in the automation tree.'
export const SELECT =
  'Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px.'
export const DIVIDERS =
  'Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights).'
export const SETTINGS_BASE = [
  'The section content and navigation match.',
  'The scrim dims and blurs the page behind it as on the web (N2).'
]
export const FIELD_FOCUS =
  "The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves)."
export const BAND_FOCUS =
  "The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`)."
export const TOAST =
  'The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual.'
export const COMPOSER_FOCUS =
  "The composer shows its focus border and inset ring while it holds the caret, as on the web (I4: its native textarea and key-capture div listen for focus, so the wrapper's `focus-within:` sees it; top edge 35 and 57 against the web's 36 and 58). At rest on the dashboard neither client focuses it: the web's mount focus finds the editor read-only while the agent loads (`document.activeElement` stays `BODY`), and GPUIX skips mount focus for a composer that mounts read-only."
export const COMPOSER_Z =
  "The composer card paints over the top of the workspace strip that follows it, as on the web (G9: the card's `relative z-10` paints in GPUI's deferred pass at priority 10 through native patch gpuix/0011, laid out in place; the card's bottom border is 28 in both, and the send button is undimmed, 30 against the web's 30, 22 before)."
export const COMPOSER_PICK =
  'After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match).'
