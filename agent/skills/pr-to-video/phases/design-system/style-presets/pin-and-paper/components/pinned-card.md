```html
<div class="pp-pinned-card">
  <!-- Nest a pp-safety-pin and/or pp-scribble-note inside as the scene calls for it. -->
  <span class="pp-pinned-card-num">{KICKER}</span>
  <h3 class="pp-pinned-card-title">{HEADLINE}</h3>
  <p class="pp-pinned-card-body">{LEDE}</p>
</div>

<style>
  /*
    The universal card pattern — the system's most repeated structural unit.
    Cream fill, 1.5px hairline ink border, 4px micro-radius, hard ink offset
    shadow (zero blur). The three together define the "pinned paper" reading;
    missing any one breaks it. A pp-safety-pin overlay at the top edge is
    expected on most instances (positioned via the consumer scene).

    Variants:
      .alt   → paper-2 (light yellow) fill — break up adjacent same-tone cards.
      .alt2  → paper-extra (warm yellow) fill + 0.9° askew rotation — the
               pinned-askew variant, max ONE per card row.
      .compact → tighter padding + smaller shadow offset (for dense grids).
      .hero    → larger shadow offset (8/9) for the highest-elevation card.
  */
  .pp-pinned-card {
    position: relative;
    background: var(--surface-cream);
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-pin-standard);
    padding: var(--card-pad-lg);
    color: var(--brand-primary);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .pp-pinned-card.alt {
    background: var(--surface-paper-2);
  }
  .pp-pinned-card.alt2 {
    background: var(--surface-paper-3);
    transform: rotate(var(--tilt-card-askew));
  }
  .pp-pinned-card.compact {
    padding: 28px 28px 24px;
    box-shadow: var(--shadow-pin-compact);
  }
  .pp-pinned-card.hero {
    box-shadow: var(--shadow-pin-hero);
    padding: 60px 80px;
  }
  .pp-pinned-card-num {
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    opacity: 0.65;
    line-height: 1;
  }
  .pp-pinned-card-title {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: clamp(28px, 2.4vw, 38px);
    line-height: 1.02;
    letter-spacing: -0.02em;
    margin: 0;
    color: var(--brand-primary);
  }
  .pp-pinned-card-body {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 400;
    font-size: clamp(24px, 1.6vw, 28px);
    line-height: 1.45;
    margin: 0;
    color: var(--brand-primary);
  }
</style>
```
