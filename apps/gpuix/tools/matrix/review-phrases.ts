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
  "The workspace status bar stays sharp above the confirm scrim, as on the web, where ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling (G9: compat gives the fixed overlay its z-index as its `<anchored>` priority, and native patch gpuix/0011 paints the `relative z-50` bar in the same deferred pass, after it in tree order; status-bar text 75 against the web's 72, dimmed to 11 before)."
export const PROSE =
  "Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently."
export const RUN_ORDER =
  'The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server.'
export const WASH =
  "Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4)."
export const CODE_CARD =
  "The bash code card's body is 81 px between its borders in both, and the card 139 px tall in both (N4: the web's `.chat-streamdown pre` keeps a 0.55em bottom margin inside the body; it was 73 px). The task list lands on the web's columns (bullet 527, checkbox 547, text 565 px in both)."
export const TAIL_OFFSET =
  "The transcript sits 3 px higher than the web's, from the last reply down: its copy and retry icons end 2 px further above the Changed files bar (545 against 548 px, the bar at 602 against 603 px). It predates N4: the user bubble ends at 387 against 390 px on the exp/gpuix-client head too."
export const TREE_TEXT =
  'The text check fails only because natively painted text is not in the automation tree.'
export const SELECT =
  'Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px.'
export const DIVIDERS =
  'Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer).'
export const LABEL_LINE =
  "A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high)."
export const HALF_PX_LINES =
  "Each `text-xs leading-relaxed` line sits 19.5 px below the last, as on the web, so later rows no longer drift (N3: native patch zed/0005 keeps the line height fractional; on settings.skills the lines start at 254, 274, 293, 313 and 333 against the web's 254, 274, 293, 313 and 332, and the last row at 658 against 659, where G12 measured 19 px steps and a 5 px drift)."
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
  "The composer shows its focus border and inset ring while it holds the caret, as on the web (I4: its native textarea and key-capture div listen for focus, so the wrapper's `focus-within:` sees it; top edge 35 and 57 against the web's 36 and 58). At rest on the dashboard both clients now show it focused: M3's full run shows the focus border on 88 of 88 web and 81 of 88 GPUIX dashboard frames, and the other 7 GPUIX frames show the resting border."
export const LAYOUT_FOCUS =
  "After the shortcut both composers rest unfocused (G12). The step first clicks the rail's Projects label, and the web blurs the composer there: Chromium's default action for a press no listener prevented moves focus to body when the pressed content takes none. GPUIX now does the same (`compat/window-press.ts`), where GPUI had kept the composer focused."
export const COMPOSER_Z =
  "The composer card paints over the top of the workspace strip that follows it, as on the web (G9: the card's `relative z-10` paints in GPUI's deferred pass at priority 10 through native patch gpuix/0011, laid out in place; the card's bottom border is 28 in both, and the send button is undimmed, 30 against the web's 30, 22 before)."
export const COMPOSER_PICK =
  'After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match).'
