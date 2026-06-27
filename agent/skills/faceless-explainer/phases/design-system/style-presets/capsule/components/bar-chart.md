```html
<!-- A horizontal pill-shaped bar chart. Each row has a label, a 36px-tall pill-radius track with a colored fill pill inside (carrying the right-edge 2px outline that gives the pill its end-cap), and a value column. Cycle fill colors through the brand palette across rows. -->
<div class="cap-chart">
  <div class="cap-chart-row">
    <div class="cap-chart-label">{LABEL}</div>
    <div class="cap-chart-track">
      <div class="cap-chart-fill cap-chart-fill-1" style="width: 82%;">82%</div>
    </div>
    <div class="cap-chart-value">{NUM}</div>
  </div>
  <div class="cap-chart-row">
    <div class="cap-chart-label">{LABEL}</div>
    <div class="cap-chart-track">
      <div class="cap-chart-fill cap-chart-fill-2" style="width: 67%;">67%</div>
    </div>
    <div class="cap-chart-value">{NUM}</div>
  </div>
  <div class="cap-chart-row">
    <div class="cap-chart-label">{LABEL}</div>
    <div class="cap-chart-track">
      <div class="cap-chart-fill cap-chart-fill-3" style="width: 45%;">45%</div>
    </div>
    <div class="cap-chart-value">{NUM}</div>
  </div>
</div>

<style>
  .cap-chart {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    background: var(--canvas);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    border-radius: var(--cap-radius-card, 2rem);
    padding: 3rem;
    box-shadow: var(--cap-shadow-lg, 8px 8px 0 color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .cap-chart-row {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .cap-chart-label {
    width: 140px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 500;
    text-align: right;
    color: var(--ink);
    flex-shrink: 0;
  }
  .cap-chart-track {
    flex: 1;
    height: 36px;
    background: var(--canvas);
    border-radius: var(--cap-radius-pill, 9999px);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    overflow: hidden;
    position: relative;
  }
  .cap-chart-fill {
    height: 100%;
    border-radius: var(--cap-radius-pill, 9999px);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 1rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 600;
    color: var(--ink);
    border-right: var(--cap-outline-w, 2px) solid var(--ink);
  }
  .cap-chart-fill-1 {
    background: var(--brand-primary);
  }
  .cap-chart-fill-2 {
    background: var(--brand-secondary);
  }
  .cap-chart-fill-3 {
    background: var(--brand-accent);
  }
  .cap-chart-value {
    width: 60px;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 600;
    color: var(--ink);
    flex-shrink: 0;
  }
</style>
```
