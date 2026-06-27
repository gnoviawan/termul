```html
<div class="cap-hero">
  <div class="cap-hero-eyebrow">{EYEBROW}</div>
  <h1 class="cap-hero-display">{HEADLINE}</h1>
  <div class="cap-hero-sub">{SUBHEAD}</div>
</div>

<style>
  .cap-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    text-align: center;
    padding: 3rem 4rem;
  }
  .cap-hero-eyebrow {
    background: var(--brand-secondary);
    color: var(--ink);
    padding: var(--cap-pad-pill-lg, 1.5rem 3.5rem);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    border-radius: var(--cap-radius-pill, 9999px);
    font-family: "Space Grotesk", sans-serif;
    font-weight: 600;
    font-size: 24px;
    letter-spacing: var(--cap-track-pill, 0.12em);
    text-transform: uppercase;
  }
  .cap-hero-display {
    font-family: "Bodoni Moda", serif;
    font-size: clamp(3rem, 8vw, 7rem);
    font-weight: 800;
    line-height: 0.9;
    letter-spacing: var(--cap-track-tight, -0.02em);
    color: var(--ink);
    margin: 0;
  }
  .cap-hero-sub {
    font-family: "Space Grotesk", sans-serif;
    font-size: clamp(24px, 1.5vw, 28px);
    font-weight: 400;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink);
    opacity: 0.6;
  }
</style>
```
