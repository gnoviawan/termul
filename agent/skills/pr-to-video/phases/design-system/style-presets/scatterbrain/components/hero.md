```html
<div class="sb-hero">
  <div class="sb-hero-main">
    <h1 class="sb-hero-display">{HEADLINE}</h1>
    <p class="sb-hero-tagline">{SUBHEAD}</p>
  </div>
  <div class="sb-hero-accent sb-hero-accent-1">{EYEBROW}</div>
  <div class="sb-hero-accent sb-hero-accent-2">{LABEL}</div>
</div>

<style>
  /*
    Hero entry-point. A large butter sticky carrying the brand name in Shrikhand
    display, with two smaller sky / blush accent stickies clustered around it at
    wilder tilts (the hand-placed cluster). Hero sticky carries BOTH pin AND tape
    (the "officially posted" treatment).

    Tilt: hero main at --tilt-quiet-l (-1.5°); accents at --tilt-loud-r and
    --tilt-wild-l. Alternate directions across the cluster.
  */
  .sb-hero {
    position: relative;
    display: inline-block;
    padding: 2rem;
  }
  .sb-hero-main {
    position: relative;
    display: inline-block;
    padding: var(--pad-postit-lg);
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
    box-shadow: var(--shadow-sticky);
    transform: rotate(var(--tilt-quiet-l));
  }
  /* Pin + tape on the hero main sticky — the "officially posted" treatment */
  .sb-hero-main::before {
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
  .sb-hero-main::after {
    content: "";
    position: absolute;
    top: var(--tape-top);
    left: 50%;
    transform: translateX(-50%) rotate(var(--tape-rot));
    width: var(--tape-w);
    height: var(--tape-h);
    background: var(--tape-fill);
    border: 1px solid var(--tape-edge);
    box-shadow: var(--tape-shadow);
    z-index: 10;
  }
  .sb-hero-display {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: clamp(2.5rem, 5vw, 4.5rem);
    line-height: 1.1;
    letter-spacing: 0.02em;
    color: var(--ink-warm);
    margin: 0;
  }
  .sb-hero-tagline {
    font-family: "Zilla Slab", serif;
    font-size: clamp(1.5rem, 1.6vw, 1.9rem);
    font-weight: 400;
    line-height: 1.6;
    color: var(--ink-warm-light);
    max-width: 520px;
    margin: 1rem 0 0;
  }
  /* Accent stickies — Caveat quips at wild tilts */
  .sb-hero-accent {
    position: absolute;
    padding: 1.2rem 1.8rem;
    box-shadow: var(--shadow-sticky);
    font-family: "Caveat", cursive;
    font-weight: 500;
    font-size: clamp(1.5rem, 1.7vw, 2rem);
    line-height: 1.3;
    color: var(--ink-warm);
    z-index: 2;
  }
  .sb-hero-accent-1 {
    top: -40px;
    right: -60px;
    transform: rotate(var(--tilt-loud-r));
    background: linear-gradient(135deg, var(--sticky-sky) 0%, var(--sticky-sky-deep) 100%);
  }
  .sb-hero-accent-2 {
    bottom: -30px;
    left: -50px;
    transform: rotate(var(--tilt-wild-l));
    background: linear-gradient(135deg, var(--sticky-blush) 0%, var(--sticky-blush-deep) 100%);
  }
</style>
```
