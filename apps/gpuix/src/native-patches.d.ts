/**
 * Fields Termul's patched @gpuix/native understands (native/gpuix-native/
 * patches). The published 0.11.0 addon ignores unknown style and theme keys,
 * so setting them is harmless there; they only take effect on the self-built
 * addon (docs/native-patches.md).
 */
import '@gpuix/native/host'

declare module '@gpuix/native/host' {
  interface StyleDesc {
    /** Picks the family's italic face (patch 0001-font-style). Inherited like the rest of the text style. */
    fontStyle?: 'normal' | 'italic'
    /**
     * CSS `letter-spacing` in em of the run's font size (patches zed/0007 +
     * gpuix/0017). Inherited like the rest of the text style.
     */
    letterSpacing?: number
    /**
     * CSS `backdrop-filter: blur(<px>)` (patch zed/0003 + gpuix/0005): the
     * Gaussian's standard deviation. Blurs what is painted behind the element,
     * inside its rounded box. Not inherited.
     */
    backdropBlur?: number
    /**
     * CSS `z-index` (patch gpuix/0011-z-index). A positive value paints the
     * element, laid out in place and under the clip around it, in GPUI's
     * deferred pass at that priority, ordered with `<anchored>` layers. A layer
     * inside a layer never sorts under the enclosing one. Not inherited.
     */
    zIndex?: number
    /** CSS `grid-column: span <n>` (patch gpuix/0016-grid-span). */
    gridColumnSpan?: number
    /** CSS `grid-row: span <n>` (patch gpuix/0016-grid-span). */
    gridRowSpan?: number
  }
  interface GpuixTheme {
    /** Markdown link text (patch 0002-markdown-theme). Unset: the text colour. */
    link?: string
    /** Markdown link underline. Unset: `textMuted`. */
    linkUnderline?: string
    /** Markdown link weight. Unset: the paragraph's. */
    linkWeight?: number
    /** Every markdown run italic (a CSS-italic blockquote). */
    fontStyle?: 'normal' | 'italic'
    /** Fill behind a markdown table's header row (patch 0010-table-cell-metrics). Unset: none. */
    tableHeaderBg?: string
    /** Markdown table rules (patch 0012-table-columns-rules). Unset: the text colour at 10%. */
    tableRule?: string
    /** The digits that open a paragraph in tabular figures, as a list marker (patch 0015-markdown-lead-tabular-nums). */
    leadTabularNums?: boolean
    /** Unordered list marker glyph, centred in the marker column (patch gpuix/0018). Unset: a 5px disc. */
    listBullet?: string
    /** List marker colour (patch gpuix/0018). Unset: `accent` at 85%. */
    listMarker?: string
  }
  interface GpuixMetrics {
    /** Inline-code glyph size as a fraction of the paragraph's, like CSS `0.88em`. */
    mdInlineCodeScale?: number
    /**
     * Inline-code padding on each side (patches zed/0004 + gpuix/0007): laid out
     * like CSS inline padding, so it pushes the text after the chip, and the
     * wash covers it.
     */
    mdInlineCodePaddingX?: number
    /** Inset of the inline-code wash from the top and bottom of the line box. */
    mdInlineCodeInsetY?: number
    /** List marker column width (patch gpuix/0018). Unset: 18. */
    mdListMarkerWidth?: number
    /** Space between the marker column and the item (patch gpuix/0018). Unset: 8. */
    mdListMarkerGap?: number
    /** Space between list items (patch gpuix/0018). Unset: 4. */
    mdListItemGap?: number
    /** Vertical table cell padding (patch 0010); `mdTableCellPadding` stays the horizontal one. */
    mdTableCellPaddingY?: number
    /** Table cell line height (patch 0010). Unset: `mdLineHeight`. */
    mdTableLineHeight?: number
    /** Table header row weight (patch 0010). Unset: 700. */
    mdTableHeaderWeight?: number
    /** Height of the rule under a table's header row (patch 0012); 0 draws none. Unset: 1. */
    mdTableHeaderRule?: number
  }
}
