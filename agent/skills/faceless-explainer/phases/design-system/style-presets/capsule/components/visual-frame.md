```html
<!-- 2rem-radius large frame with 12px offset shadow, tri-stop brand-gradient fill, dot-grid overlay, and inner dashed border. Used as hero visual placeholder. -->
<div class="cap-vframe">
  <div class="cap-vframe-pattern"></div>
  <div class="cap-vframe-inner">
    <span class="cap-vframe-label">{LABEL}</span>
  </div>
</div>

<style>
  .cap-vframe {
    width: 100%;
    height: 450px;
    border-radius: var(--cap-radius-card, 2rem);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    background: linear-gradient(
      135deg,
      var(--brand-primary) 0%,
      var(--brand-secondary) 50%,
      var(--brand-accent) 100%
    );
    position: relative;
    overflow: hidden;
    box-shadow: var(--cap-shadow-xl, 12px 12px 0 color-mix(in srgb, var(--ink) 8%, transparent));
  }
  .cap-vframe-pattern {
    position: absolute;
    inset: 0;
    opacity: 0.15;
    background-image:
      radial-gradient(circle at 25% 25%, var(--ink) 2px, transparent 2px),
      radial-gradient(circle at 75% 75%, var(--ink) 2px, transparent 2px);
    background-size: 40px 40px;
  }
  .cap-vframe-inner {
    position: absolute;
    inset: 2rem;
    border-radius: var(--cap-radius-inner, 1.5rem);
    border: var(--cap-outline-w, 2px) dashed var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cap-vframe-label {
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink);
    opacity: 0.5;
  }
</style>
```
