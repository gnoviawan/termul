```html
<div class="bf-hero">
  <div class="bf-hero-frame">
    <div class="bf-corner bf-corner-tl"></div>
    <div class="bf-corner bf-corner-tr"></div>
    <div class="bf-corner bf-corner-bl"></div>
    <div class="bf-corner bf-corner-br"></div>
    <span class="bf-hero-eyebrow">{EYEBROW}</span>
    <h1 class="bf-hero-display">{HEADLINE}</h1>
    <p class="bf-hero-subhead">{SUBHEAD}</p>
    <div class="bf-hero-tab">{LABEL}</div>
    <div class="bf-hero-deco-rect"></div>
  </div>
</div>

<style>
  .bf-hero {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--canvas);
    padding: 6vw;
  }
  .bf-hero-frame {
    position: relative;
    max-width: 60vw;
    border: var(--bf-border-bold);
    background: var(--canvas);
    padding: var(--bf-pad-card-lg);
    box-shadow: var(--bf-shadow);
  }
  .bf-hero-eyebrow {
    display: inline-block;
    border: var(--bf-border-mid);
    background: var(--brand-primary);
    color: var(--ink);
    padding: 6px 16px;
    margin-bottom: 24px;
    font-family: "Space Grotesk", monospace;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: var(--bf-shadow-sm);
  }
  .bf-hero-display {
    font-family: "Inter", sans-serif;
    font-weight: 900;
    font-size: clamp(56px, 7vw, 120px);
    line-height: 0.95;
    letter-spacing: -0.03em;
    text-transform: uppercase;
    color: var(--ink);
    margin-bottom: 32px;
  }
  .bf-hero-subhead {
    font-family: "Space Grotesk", monospace;
    font-size: clamp(24px, 1.6vw, 30px);
    font-weight: 500;
    line-height: 1.5;
    color: var(--ink);
    opacity: 0.85;
    max-width: 32vw;
  }
  .bf-hero-tab {
    position: absolute;
    bottom: -18px;
    left: 60px;
    padding: 8px 20px;
    background: var(--brand-accent);
    border: var(--bf-border-bold);
    box-shadow: var(--bf-shadow-sm);
    transform: rotate(-3deg);
    font-family: "Space Grotesk", monospace;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink);
  }
  .bf-hero-deco-rect {
    position: absolute;
    top: -30px;
    right: 60px;
    width: 96px;
    height: 96px;
    background: var(--brand-secondary);
    border: var(--bf-border-bold);
    box-shadow: var(--bf-shadow-sm);
    transform: rotate(var(--bf-tilt-loud));
  }
  .bf-corner {
    position: absolute;
    width: 24px;
    height: 24px;
    border: var(--bf-border-mid);
  }
  .bf-corner-tl {
    top: 12px;
    left: 12px;
    border-right: none;
    border-bottom: none;
  }
  .bf-corner-tr {
    top: 12px;
    right: 12px;
    border-left: none;
    border-bottom: none;
  }
  .bf-corner-bl {
    bottom: 12px;
    left: 12px;
    border-right: none;
    border-top: none;
  }
  .bf-corner-br {
    bottom: 12px;
    right: 12px;
    border-left: none;
    border-top: none;
  }
</style>
```
