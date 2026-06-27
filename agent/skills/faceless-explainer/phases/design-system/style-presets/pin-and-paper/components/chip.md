```html
<span class="pp-chip">{LABEL}</span>

<style>
  /*
    DM Mono uppercase archival tag — the "catalog-card" voice. Used as
    top-chrome lockup, date strip, source attribution, scene-level meta tag.
    No background, no border by default — it's a label, not a UI chip. The
    tracking (0.18em) is load-bearing; tighter and it reads as generic mono.
  */
  .pp-chip {
    display: inline-block;
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    line-height: 1;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--brand-primary);
    padding: 6px 0;
  }
  /* Footer / muted variant. */
  .pp-chip.muted {
    opacity: 0.65;
    font-size: 24px;
    letter-spacing: 0.14em;
  }
  /* Boxed variant — when the chip needs to read as a tag, not a label.
     Hairline ink border, micro-radius, cream fill. */
  .pp-chip.boxed {
    background: var(--surface-cream);
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    padding: 6px 14px;
  }
</style>
```
