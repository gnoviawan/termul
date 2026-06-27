```html
<span class="sb-chip">{LABEL}</span>

<style>
  /*
    Caveat label-script eyebrow — uppercase, tracked 0.15em, soft warm ink. Sits
    above a card title or as a small categorical tag. Caveat at normal tracking
    reads as a body cursive; the uppercase + tracking turns it into a categorical
    label. The single most distinctive small voice in the system — never replace
    with italic Zilla Slab.
  */
  .sb-chip {
    display: inline-block;
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-warm-light);
  }
  /* Variants color the tracked label by brand role — use sparingly. */
  .sb-chip.primary {
    color: var(--brand-primary);
    font-weight: 500;
  }
  .sb-chip.secondary {
    color: var(--brand-secondary);
    font-weight: 500;
  }
  .sb-chip.accent {
    color: var(--brand-accent);
    font-weight: 500;
  }
</style>
```
