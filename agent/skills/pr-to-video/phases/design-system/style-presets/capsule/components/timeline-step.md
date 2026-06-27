```html
<!-- Cycle the step-node literal "1" / "2" / "3" / "4" / "5" across instances (decorative ordinal, hardcoded). -->
<!-- Cycle the step-node background through the brand palette: primary, secondary, accent, then repeat. -->
<div class="cap-step">
  <div class="cap-step-node">1</div>
  <div class="cap-step-label">{LABEL}</div>
  <div class="cap-step-desc">{LEDE}</div>
</div>

<style>
  .cap-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    max-width: 220px;
  }
  .cap-step-node {
    width: var(--cap-step-size, 56px);
    height: var(--cap-step-size, 56px);
    border-radius: 50%;
    border: var(--cap-outline-w, 2px) solid var(--ink);
    background: var(--brand-primary);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Bodoni Moda", serif;
    font-size: 28px;
    font-weight: 700;
    flex-shrink: 0;
    box-shadow: var(--cap-shadow-sm, 4px 4px 0 color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .cap-step-label {
    text-align: center;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink);
    line-height: 1.3;
  }
  .cap-step-desc {
    text-align: center;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    line-height: 1.4;
    color: var(--ink);
    opacity: 0.55;
    margin-top: -0.5rem;
  }
</style>
```
