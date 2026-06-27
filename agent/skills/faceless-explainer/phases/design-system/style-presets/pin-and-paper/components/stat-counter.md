```html
<div class="pp-stat-counter">
  <div class="pp-stat-counter-num">
    {NUM}<small class="pp-stat-counter-unit">M</small>
    <!-- Don't use Space Grotesk for the suffix — the script face is load-bearing. -->
  </div>
  <h3 class="pp-stat-counter-label">{HEADLINE}</h3>
  <p class="pp-stat-counter-body">{LEDE}</p>
</div>

<style>
  /*
    Hero stat block. Cream card pattern (1.5px ink border, 4px micro-radius,
    hard ink offset shadow). Big Space Grotesk 700 numeral with a Caveat
    <small> unit suffix — the script suffix is the system's signature mix:
    a printed numeral with a hand-counted unit tag.

    Variants:
      .alt   — paper-2 fill.
      .alt2  — paper-extra fill + 0.9° askew rotation.

    Often combined with a pp-safety-pin overlay at the top edge of the card.
  */
  .pp-stat-counter {
    position: relative;
    background: var(--surface-cream);
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-pin-standard);
    padding: 32px 30px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    color: var(--brand-primary);
  }
  .pp-stat-counter.alt {
    background: var(--surface-paper-2);
  }
  .pp-stat-counter.alt2 {
    background: var(--surface-paper-3);
    transform: rotate(var(--tilt-card-askew));
  }
  .pp-stat-counter-num {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: clamp(96px, 12vw, 168px);
    line-height: 0.85;
    letter-spacing: -0.04em;
    margin-top: 16px;
    color: var(--brand-primary);
  }
  .pp-stat-counter-unit {
    font-family: "Caveat", cursive;
    font-weight: 700;
    font-size: clamp(40px, 4vw, 60px);
    vertical-align: top;
    margin-left: 6px;
    line-height: 1;
  }
  .pp-stat-counter-label {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: 26px;
    line-height: 1.05;
    letter-spacing: -0.015em;
    margin: auto 0 0;
    color: var(--brand-primary);
  }
  .pp-stat-counter-body {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 400;
    font-size: 24px;
    line-height: 1.45;
    margin: 0;
    color: var(--brand-primary);
  }
</style>
```
