```html
<!-- In a 3-up grid, cycle the icon literal: "I" / "II" / "III" (decorative Roman numerals, hardcoded). -->
<!-- Cycle the icon background between var(--brand-primary), var(--brand-secondary), var(--brand-accent) across instances. -->
<div class="cap-pillar">
  <div class="cap-pillar-icon">I</div>
  <h3 class="cap-pillar-title">{HEADLINE}</h3>
  <p class="cap-pillar-body">{LEDE}</p>
</div>

<style>
  .cap-pillar {
    background: var(--canvas);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    border-radius: var(--cap-radius-card, 2rem);
    padding: var(--cap-pad-card, 2.5rem 2rem);
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    box-shadow: var(--cap-shadow-lg, 8px 8px 0 color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .cap-pillar-icon {
    width: var(--cap-icon-size, 60px);
    height: var(--cap-icon-size, 60px);
    border-radius: 50%;
    border: var(--cap-outline-w, 2px) solid var(--ink);
    background: var(--brand-primary);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Bodoni Moda", serif;
    font-size: 1.5rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .cap-pillar-title {
    font-family: "Bodoni Moda", serif;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
    color: var(--ink);
    margin: 0;
  }
  .cap-pillar-body {
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    line-height: 1.55;
    color: var(--ink);
    opacity: 0.65;
    margin: 0;
  }
</style>
```
