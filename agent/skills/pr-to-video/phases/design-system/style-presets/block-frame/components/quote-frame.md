```html
<div class="bf-quote-frame">
  <div class="bf-quote-mark">"</div>
  <p class="bf-quote-text">{QUOTE}</p>
  <p class="bf-quote-author">{AUTHOR}</p>
  <div class="bf-quote-stripes"></div>
</div>

<style>
  .bf-quote-frame {
    position: relative;
    border: var(--bf-border-bold);
    background: var(--canvas);
    padding: var(--bf-pad-card-lg) 80px;
    box-shadow: var(--bf-shadow);
    max-width: 1000px;
    color: var(--ink);
  }
  .bf-quote-mark {
    position: absolute;
    top: -30px;
    left: 40px;
    font-family: "Inter", sans-serif;
    font-weight: 900;
    font-size: 120px;
    line-height: 1;
    color: var(--brand-accent);
    -webkit-text-stroke: 3px var(--ink);
  }
  .bf-quote-text {
    font-family: "Inter", sans-serif;
    font-weight: 900;
    font-size: clamp(28px, 3.5vw, 52px);
    line-height: 1.15;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    margin-bottom: 32px;
    color: var(--ink);
  }
  .bf-quote-author {
    font-family: "Space Grotesk", monospace;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink);
    opacity: 0.85;
  }
  .bf-quote-stripes {
    position: absolute;
    bottom: -20px;
    right: 60px;
    width: 80px;
    height: 80px;
    background: repeating-linear-gradient(
      45deg,
      var(--ink),
      var(--ink) 4px,
      var(--brand-primary) 4px,
      var(--brand-primary) 12px
    );
    border: var(--bf-border-mid);
    transform: rotate(var(--bf-tilt-md-r));
  }
</style>
```
