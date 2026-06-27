```html
<div class="cl-number-lockup">
  <div class="cl-number-figure">{NUM}<span class="cl-number-unit">%</span></div>
  <p class="cl-number-caption">{LABEL}</p>
</div>

<style>
  /*
    A single hero stat for a whole scene — borderless on the cream floor. A huge
    Fraunces figure with a JetBrains Mono unit; an Inter caption below. The figure
    counts up on entry; the unit fades in at the end of the count. Swap the literal
    "%" unit for ×, K, M, s, etc.
  */
  .cl-number-lockup {
    display: flex;
    flex-direction: column;
    gap: 20px;
    color: var(--brand-primary);
  }
  .cl-number-figure {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(120px, 16vw, 280px);
    line-height: 0.9;
    letter-spacing: -0.035em;
    color: var(--brand-primary);
  }
  .cl-number-unit {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 40px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--brand-accent);
    margin-left: 0.1em;
    vertical-align: 0.7em;
  }
  .cl-number-caption {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 28px;
    line-height: 1.4;
    letter-spacing: 0.01em;
    color: var(--cl-ink-muted);
    margin: 0;
    max-width: 32ch;
  }
</style>
```
