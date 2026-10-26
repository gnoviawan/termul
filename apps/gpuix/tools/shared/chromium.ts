/**
 * Launch flags for every Chromium that paints the web reference GPUIX is
 * compared against.
 *
 * `--font-render-hinting=slight`: headless Chromium defaults to `full`, which
 * lays text out on FreeType-hinted whole-pixel advances, so a line of 13px
 * Inter came out 2.2% wider than the font's design widths and a 14px line
 * 0.7% narrower, and an auto-layout table's columns moved 6 to 7 px with the
 * hinted cell widths. Desktop Chrome on Linux follows fontconfig, `slight` on
 * stock GNOME and Ubuntu, and macOS and Windows browsers lay out fractional
 * advances; GPUIX lays out the design widths too (`tools/native/typo-check.ts`
 * measures both).
 *
 * The network flag lets the page reach the test server on 127.0.0.1.
 */
export const WEB_REFERENCE_ARGS = [
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks',
  '--font-render-hinting=slight'
]
