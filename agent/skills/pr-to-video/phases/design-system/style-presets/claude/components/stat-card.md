```html
<div class="cl-stat-card">
  <span class="cl-stat-badge">{EYEBROW}</span>
  <div class="cl-stat-num">{NUM}<span class="cl-stat-unit">M</span></div>
  <h3 class="cl-stat-title">{HEADLINE}</h3>
  <p class="cl-stat-body">{LEDE}</p>
</div>

<style>
  /*
    A carded stat on the warm tile surface, lifted only by a hairline (claude's
    elevation language). Big Fraunces figure with a JetBrains Mono unit suffix —
    the signature mix of a serif numeral and a mono unit. For a 3-up row, render
    the middle instance with .center (navy ground, cream text, larger figure) so
    the row has one clear focal.
  */
  .cl-stat-card {
    background: var(--cl-tile);
    border: var(--cl-border-hairline);
    border-radius: var(--cl-radius-lg);
    padding: 36px 32px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    color: var(--brand-primary);
  }
  .cl-stat-card.center {
    background: var(--cl-navy);
    border-color: var(--cl-hairline-dark);
    color: var(--cl-on-dark);
  }
  .cl-stat-badge {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--cl-ink-muted);
  }
  .cl-stat-card.center .cl-stat-badge {
    color: var(--brand-accent);
  }
  .cl-stat-num {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(80px, 9vw, 132px);
    line-height: 0.9;
    letter-spacing: -0.03em;
    margin-top: 16px;
    color: var(--brand-primary);
  }
  .cl-stat-card.center .cl-stat-num {
    color: var(--cl-on-dark);
  }
  .cl-stat-unit {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 28px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--cl-ink-muted);
    margin-left: 0.18em;
    vertical-align: 0.6em;
  }
  .cl-stat-card.center .cl-stat-unit {
    color: var(--cl-on-dark-soft);
  }
  .cl-stat-title {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 28px;
    line-height: 1.25;
    letter-spacing: -0.005em;
    margin: auto 0 0;
    color: var(--brand-primary);
  }
  .cl-stat-card.center .cl-stat-title {
    color: var(--cl-on-dark);
  }
  .cl-stat-body {
    font-family: "Inter", sans-serif;
    font-weight: 400;
    font-size: 24px;
    line-height: 1.5;
    margin: 0;
    color: var(--cl-ink-body);
  }
  .cl-stat-card.center .cl-stat-body {
    color: var(--cl-on-dark-soft);
  }
</style>
```
