```html
<!-- Feature post-it with a 60px round ink-bordered icon containing a single
     Shrikhand glyph (A / B / C, 1 / 2 / 3, or a brand-relevant character).
     Hardcode the glyph per instance in a multi-card grid. -->
<div class="sb-feature-card pin" style="transform: rotate(var(--tilt-loud-l));">
  <div class="sb-feature-icon">A</div>
  <h3 class="sb-feature-title">{HEADLINE}</h3>
  <p class="sb-feature-body">{SUBHEAD}</p>
</div>

<style>
  /*
    Feature post-it — the categorical card in a 3-column grid. Always opens with
    a 60px round ink-bordered icon containing a single Shrikhand character. The
    icon is the visual signature; substituting a sans-serif glyph or dropping
    the 3px ink border breaks the workshop voice.

    Default fill is butter; in a multi-card grid, cycle through sky / blush /
    mint variants. Each card carries its own ink pin via ::before.

    In a 3-card grid, set background-color per card via a .sky / .blush / .mint
    variant class and set the icon glyph per card (A/B/C or brand-relevant character).
  */
  .sb-feature-card {
    position: relative;
    padding: 2.5rem 2rem;
    text-align: center;
    box-shadow: var(--shadow-sticky);
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
    z-index: 1;
  }
  .sb-feature-card.sky {
    background: linear-gradient(135deg, var(--sticky-sky) 0%, var(--sticky-sky-deep) 100%);
  }
  .sb-feature-card.blush {
    background: linear-gradient(135deg, var(--sticky-blush) 0%, var(--sticky-blush-deep) 100%);
  }
  .sb-feature-card.mint {
    background: linear-gradient(135deg, var(--sticky-mint) 0%, var(--sticky-mint-deep) 100%);
  }
  /* Pin via ::before — default red */
  .sb-feature-card.pin::before {
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
  .sb-feature-icon {
    width: var(--feature-icon-size);
    height: var(--feature-icon-size);
    margin: 0 auto 1.5rem;
    border: var(--feature-icon-border);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 1.5rem;
    color: var(--ink-warm);
  }
  .sb-feature-title {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.1;
    letter-spacing: 0.02em;
    color: var(--ink-warm);
    margin: 0 0 1rem;
  }
  .sb-feature-body {
    font-family: "Zilla Slab", serif;
    font-size: clamp(1.5rem, 1.6vw, 1.6rem);
    font-weight: 400;
    line-height: 1.6;
    color: var(--ink-warm-light);
    margin: 0;
  }
</style>
```
