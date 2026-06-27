```html
<div class="cl-chip-row">
  <span class="cl-chip cl-chip-coral">{LABEL}</span>
  <span class="cl-chip cl-chip-cream">{EYEBROW}</span>
  <span class="cl-chip cl-chip-cream">{SUBHEAD}</span>
</div>

<style>
  /*
    A row of pills: one coral pill carries the "new / lead" tag (uppercase tracked),
    cream pills with a hairline carry the rest. The coral pill is the only coral in
    the row — the rest stay quiet. Use for categories, tags, or a small badge cluster.
  */
  .cl-chip-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
  }
  .cl-chip {
    display: inline-flex;
    align-items: center;
    border-radius: var(--cl-radius-pill);
    font-family: "Inter", sans-serif;
    font-weight: 500;
  }
  .cl-chip-coral {
    background: var(--brand-accent);
    color: var(--cl-on-dark);
    font-size: 24px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    padding: 10px 24px;
  }
  .cl-chip-cream {
    background: var(--cl-tile);
    color: var(--brand-primary);
    border: var(--cl-border-hairline);
    font-size: 26px;
    padding: 10px 26px;
  }
</style>
```
