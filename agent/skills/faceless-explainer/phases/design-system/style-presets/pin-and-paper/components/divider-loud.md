```html
<hr class="pp-divider-loud" />

<style>
  /*
    The dashed-ink inter-row divider — used between agenda rows, between CTA
    steps, between source notes inside cards. 1.5px dashed at 45% ink opacity
    creates the "graph-paper line break" feel. The dashed pattern is the
    system's only secondary border style — solid + dashed are the two voices.

    Variants:
      .solid — 1.5px solid ink (used as section separators inside cards).
      .ruled — 2px solid ink (used as the Caveat .underline equivalent at
               block level; rare).

    NEVER use a 1px border — the hairline weight in this system is 1.5px.
    NEVER use box-shadow on a divider — the offset shadow is for cards only.
  */
  .pp-divider-loud {
    border: 0;
    border-top: var(--border-dashed);
    margin: 0;
    width: 100%;
    height: 0;
  }
  .pp-divider-loud.solid {
    border-top: var(--border-hairline);
  }
  .pp-divider-loud.ruled {
    border-top: 2px solid var(--brand-primary);
  }
</style>
```
