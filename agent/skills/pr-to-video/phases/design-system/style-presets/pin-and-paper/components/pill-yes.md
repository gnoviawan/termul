```html
<span class="pp-pill-yes">{LABEL}</span>

<style>
  /*
    Affirmative pill — the system's signature "handwritten letters inside a UI
    pill shape" treatment. Solid ink fill with paper-yellow Caveat text,
    rounded 999px, hairline ink border. The mismatch between rounded UI shape
    and handwritten letterforms is INTENTIONAL — this is the preset's most
    surprising decoration.

    Variants:
      .part — partial-state pill: paper-2 fill, ink Caveat text.
      .no   — negative pill: red mono uppercase text in a red-bordered
              transparent pill. The ONLY other place red appears outside the
              pp-stamp component. Different family + casing — the negative
              state intentionally reads as "official rejection stamp" while
              .yes and .part feel hand-counted.

    NEVER set Space Grotesk inside this pill — the Caveat letterform is the
    point.
  */
  .pp-pill-yes {
    display: inline-block;
    background: var(--brand-primary);
    color: var(--surface-paper);
    border: var(--border-hairline);
    border-radius: var(--radius-pill);
    padding: 4px 14px;
    font-family: "Caveat", cursive;
    font-weight: 600;
    font-size: 28px;
    line-height: 1;
  }
  .pp-pill-yes.part {
    background: var(--surface-paper-2);
    color: var(--brand-primary);
  }
  .pp-pill-yes.no {
    background: transparent;
    color: var(--brand-accent);
    border: 1.5px solid var(--brand-accent);
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
</style>
```
