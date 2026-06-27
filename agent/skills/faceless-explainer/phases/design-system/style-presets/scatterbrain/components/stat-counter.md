```html
<div class="sb-stat-counter pin" style="transform: rotate(var(--tilt-quiet-r));">
  <span class="sb-stat-counter-label">{EYEBROW}</span>
  <div class="sb-stat-counter-row">
    <span class="sb-stat-counter-row-label">{LABEL}</span>
    <span class="sb-stat-counter-num">{NUM}</span>
  </div>
  <div class="sb-stat-counter-row">
    <span class="sb-stat-counter-row-label">{LEFT}</span>
    <span class="sb-stat-counter-num">{NUM}</span>
  </div>
  <p class="sb-stat-counter-quip">{SUBHEAD}</p>
</div>

<style>
  /*
    Stat post-it — a yellow / butter sticky hosting 2-4 stat rows. Each row is a
    Zilla Slab label paired with a Shrikhand numerical value, separated by a
    dashed ink-alpha hairline. A Caveat quip closes the sticky ("Numbers tell the
    story we need to hear.").

    Phase 4b note: numerals count up on entry with power2.out, ~0.6s, snapping
    to the final value. Do not use steps().
  */
  .sb-stat-counter {
    position: relative;
    padding: var(--pad-postit-md);
    box-shadow: var(--shadow-sticky);
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
    z-index: 1;
  }
  .sb-stat-counter.pin::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--pin-red-light), var(--pin-red-deep));
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }
  .sb-stat-counter-label {
    display: block;
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 400;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-warm-light);
    margin-bottom: 1rem;
  }
  .sb-stat-counter-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 0;
    border-bottom: 1px dashed var(--ink-hairline);
  }
  .sb-stat-counter-row-label {
    font-family: "Zilla Slab", serif;
    font-size: 1.5rem;
    font-weight: 400;
    color: var(--ink-warm-light);
  }
  .sb-stat-counter-num {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 2rem;
    line-height: 1.1;
    color: var(--ink-warm);
  }
  .sb-stat-counter-quip {
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 500;
    line-height: 1.3;
    color: var(--ink-warm);
    margin: 1.5rem 0 0;
  }
</style>
```
