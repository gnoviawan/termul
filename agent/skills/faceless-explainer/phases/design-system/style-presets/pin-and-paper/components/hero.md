```html
<div class="pp-hero">
  <span class="pp-hero-eyebrow">{EYEBROW}</span>
  <h1 class="pp-hero-display">{HEADLINE}</h1>
  <p class="pp-hero-subhead">{SUBHEAD}</p>
</div>

<style>
  /*
    Cover headline block. Yellow paper surface (the layered paper-grain-overlay
    sits on the scene root, NOT on the hero). Space Grotesk 700 mixed case
    with tight negative letter-spacing — the "printed-poster" voice. DM Mono
    eyebrow above, Caveat-tone subhead below. Prefix: pp- (pin-paper).
  */
  .pp-hero {
    background: var(--surface-paper);
    padding: 110px 64px 80px;
    position: relative;
    color: var(--brand-primary);
  }
  .pp-hero-eyebrow {
    display: block;
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    opacity: 0.85;
    margin-bottom: 32px;
  }
  .pp-hero-display {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: clamp(72px, 10vw, 196px);
    line-height: 1.08;
    letter-spacing: -0.04em;
    color: var(--brand-primary);
    margin: 0;
    max-width: 14ch;
  }
  .pp-hero-subhead {
    font-family: "Caveat", cursive;
    font-weight: 600;
    font-size: clamp(28px, 2.4vw, 38px);
    line-height: 1.1;
    color: var(--brand-primary);
    transform: rotate(-2deg);
    transform-origin: left bottom;
    margin-top: 40px;
    max-width: 40ch;
  }
</style>
```
