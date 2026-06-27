```html
<div class="bf-stat-counter">
  <div class="bf-stat-deco-dot"></div>
  <div class="bf-stat-num">{NUM}</div>
  <div class="bf-stat-label">{LABEL}</div>
</div>

<style>
  .bf-stat-counter {
    position: relative;
    border: var(--bf-border-bold);
    background: var(--canvas);
    padding: var(--bf-pad-card-sm);
    box-shadow: var(--bf-shadow-sm);
    text-align: center;
    color: var(--ink);
    transform: rotate(var(--bf-tilt-sm-l));
  }
  .bf-stat-deco-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: var(--bf-border-thin);
    background: var(--brand-secondary);
  }
  .bf-stat-num {
    font-family: "Inter", sans-serif;
    font-weight: 900;
    font-size: clamp(36px, 4vw, 64px);
    line-height: 1;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
    color: var(--ink);
  }
  .bf-stat-label {
    font-family: "Space Grotesk", monospace;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink);
    opacity: 0.85;
  }
</style>
```
