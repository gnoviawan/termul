```html
<blockquote class="cap-quote">
  <span class="cap-quote-mark">&ldquo;</span>
  {QUOTE}
  <div class="cap-quote-attr">{AUTHOR}</div>
</blockquote>

<style>
  .cap-quote {
    position: relative;
    max-width: 900px;
    padding: 3rem;
    text-align: center;
    font-family: "Bodoni Moda", serif;
    font-size: clamp(26px, 3.5vw, 48px);
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 0;
  }
  .cap-quote-mark {
    font-family: "Bodoni Moda", serif;
    font-size: 8rem;
    line-height: 0;
    color: var(--brand-primary);
    opacity: 0.3;
    position: absolute;
    top: 2rem;
    left: 0;
  }
  .cap-quote em,
  .cap-quote .cap-quote-hilite {
    display: inline-block;
    background: var(--brand-secondary);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    border-radius: var(--cap-radius-pill, 9999px);
    padding: 0.1rem 0.8rem;
    font-style: normal;
    font-weight: 700;
    color: var(--ink);
  }
  .cap-quote-attr {
    margin-top: 2rem;
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink);
    opacity: 0.5;
  }
</style>
```
