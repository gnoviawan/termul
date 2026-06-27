```html
<div class="sb-compare-card">
  <div class="sb-compare-card-left pin-blue" style="transform: rotate(var(--tilt-quiet-l));">
    <h3 class="sb-compare-card-title">{LEFT}</h3>
    <ul class="sb-compare-card-list">
      <li>{DO_1}</li>
      <li>{DO_2}</li>
      <li>{DO_3}</li>
    </ul>
  </div>
  <div class="sb-compare-card-vs">vs</div>
  <div class="sb-compare-card-right pin-gold" style="transform: rotate(var(--tilt-quiet-r));">
    <h3 class="sb-compare-card-title">{RIGHT}</h3>
    <ul class="sb-compare-card-list">
      <li>{DONT_1}</li>
      <li>{DONT_2}</li>
      <li>{DONT_3}</li>
    </ul>
  </div>
</div>

<style>
  /*
    Side-by-side comparison — two stickies (blue + butter) divided by a centered
    ink-filled versus-circle. The versus-circle is the connector marker; its
    cream-on-ink contrast carries through any brand DNA. Use for before/after,
    do/don't, or with/without beats.

    Tilt: -1.5° left, +1.5° right (use --tilt-quiet-l / --tilt-quiet-r).
    Pin colors match the sticky underneath for cohesion.
  */
  .sb-compare-card {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3rem;
    align-items: stretch;
    max-width: 1000px;
    margin: 0 auto;
  }
  .sb-compare-card-left,
  .sb-compare-card-right {
    position: relative;
    padding: 3rem;
    box-shadow: var(--shadow-sticky);
    z-index: 1;
  }
  .sb-compare-card-left {
    background: linear-gradient(135deg, var(--sticky-sky) 0%, var(--sticky-sky-deep) 100%);
  }
  .sb-compare-card-right {
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
  }
  /* Pin variants — blue on the left sticky, gold on the right */
  .sb-compare-card-left.pin-blue::before,
  .sb-compare-card-right.pin-gold::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }
  .sb-compare-card-left.pin-blue::before {
    background: radial-gradient(
      circle at 30% 30%,
      color-mix(in srgb, var(--brand-secondary) 60%, var(--pin-blue-light)),
      color-mix(in srgb, var(--brand-secondary) 80%, var(--pin-blue-deep))
    );
  }
  .sb-compare-card-right.pin-gold::before {
    background: radial-gradient(circle at 30% 30%, var(--pin-gold-light), var(--pin-gold-deep));
  }
  .sb-compare-card-title {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: clamp(1.75rem, 2.5vw, 2.2rem);
    line-height: 1.1;
    letter-spacing: 0.02em;
    text-align: center;
    color: var(--ink-warm);
    margin: 0 0 1.5rem;
    padding-bottom: 0.8rem;
    border-bottom: 3px solid var(--ink-warm);
  }
  .sb-compare-card-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .sb-compare-card-list li {
    font-family: "Zilla Slab", serif;
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1.5;
    color: var(--ink-warm-light);
    padding: 0.8rem 0;
    border-bottom: 1px solid var(--ink-hairline-soft);
  }
  .sb-compare-card-list li:last-child {
    border-bottom: none;
  }
  /* Versus circle — ink-filled circle, cream Shrikhand, centered between the two */
  .sb-compare-card-vs {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 60px;
    height: 60px;
    background: var(--ink-warm);
    color: var(--paper-cream);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 1.5rem;
    box-shadow: 0 2px 8px var(--shadow-paper-deep);
    z-index: 10;
  }
</style>
```
