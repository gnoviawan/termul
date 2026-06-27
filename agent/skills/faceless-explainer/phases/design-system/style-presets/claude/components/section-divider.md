```html
<div class="cl-divider">
  <span class="cl-divider-kicker"><span class="cl-divider-spike">&#10033;</span> {EYEBROW}</span>
  <h2 class="cl-divider-title">{HEADLINE}</h2>
</div>

<style>
  /*
    The dark pacing beat — a full navy product-chrome divider that breaks the cream
    run (cream → navy → cream is the system's rhythm). Cream Fraunces title, a coral
    ✱ spike kicker. Use it as a chapter break between sections of an explainer.
  */
  .cl-divider {
    background: var(--cl-navy);
    color: var(--cl-on-dark);
    padding: 96px 80px;
    display: flex;
    flex-direction: column;
    gap: 32px;
    border-radius: var(--cl-radius-lg);
  }
  .cl-divider-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cl-on-dark-soft);
  }
  .cl-divider-spike {
    color: var(--brand-accent);
    font-size: 26px;
  }
  .cl-divider-title {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(64px, 8vw, 168px);
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--cl-on-dark);
    margin: 0;
    max-width: 18ch;
  }
  .cl-divider-title em {
    font-style: italic;
    color: var(--brand-accent);
  }
</style>
```
