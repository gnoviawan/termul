```html
<div class="pp-process-step">
  <!-- Set the numeral literal per step instance (1 / 2 / 3 / 4 / 5).
       Caveat hand-script numeral is the system's ordering voice — never substitute
       Space Grotesk numerals or a CSS list-counter. -->
  <span class="pp-process-step-num">1</span>
  <h3 class="pp-process-step-title">{HEADLINE}</h3>
  <p class="pp-process-step-body">{SUBHEAD}</p>
</div>

<style>
  /*
    Process / roadmap step card. Cream-card pattern with the Caveat
    hand-script ordinal at the top. The numeral is load-bearing — it signals
    "step counted by hand, not by an algorithm". Sits in a 3-to-5 column flow
    with 22px gaps; place a pp-safety-pin overlay centered on the top edge
    for the full pinned look.

    Variants:
      .alt   — paper-2 fill.
      .alt2  — paper-extra fill + 0.9° askew rotation.
      .compact — drops body, used for tight 5-card flows.
  */
  .pp-process-step {
    position: relative;
    background: var(--surface-cream);
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-pin-compact);
    padding: 32px 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--brand-primary);
  }
  .pp-process-step.alt {
    background: var(--surface-paper-2);
  }
  .pp-process-step.alt2 {
    background: var(--surface-paper-3);
    transform: rotate(var(--tilt-card-askew));
  }
  .pp-process-step-num {
    font-family: "Caveat", cursive;
    font-weight: 700;
    font-size: clamp(50px, 5vw, 70px);
    line-height: 0.9;
    color: var(--brand-primary);
  }
  .pp-process-step-title {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700;
    font-size: clamp(28px, 2.4vw, 34px);
    line-height: 1.05;
    letter-spacing: -0.015em;
    margin: 0;
    color: var(--brand-primary);
  }
  .pp-process-step-body {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 400;
    font-size: 24px;
    line-height: 1.4;
    margin: 0;
    color: var(--brand-primary);
  }
</style>
```
