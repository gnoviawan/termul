```html
<div class="cap-stat">
  <div class="cap-stat-num">{NUM}</div>
  <div class="cap-stat-label">{LABEL}</div>
  <div class="cap-stat-bar"></div>
</div>

<style>
  .cap-stat {
    background: var(--canvas);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    border-radius: var(--cap-radius-card, 2rem);
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.75rem;
    box-shadow: var(--cap-shadow-md, 6px 6px 0 color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .cap-stat-num {
    font-family: "Bodoni Moda", serif;
    font-size: clamp(2rem, 3.5vw, 3rem);
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--brand-primary);
  }
  .cap-stat-label {
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink);
    opacity: 0.6;
    line-height: 1.3;
  }
  .cap-stat-bar {
    width: var(--cap-accent-line-w, 60px);
    height: var(--cap-accent-line-h, 4px);
    background: var(--brand-primary);
    border-radius: var(--cap-radius-pill, 9999px);
    margin-top: 0.25rem;
  }
</style>
```
