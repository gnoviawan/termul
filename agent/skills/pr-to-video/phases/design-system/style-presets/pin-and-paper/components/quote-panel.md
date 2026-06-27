```html
<div class="pp-quote-panel">
  <div class="pp-quote-panel-mark" aria-hidden="true">&ldquo;</div>
  <div class="pp-quote-panel-content">
    <blockquote class="pp-quote-panel-body">{QUOTE}</blockquote>
    <div class="pp-quote-panel-attr">{AUTHOR}</div>
  </div>
</div>

<style>
  /*
    Pull-quote panel — the highest-elevation card in the system. Uses the
    largest shadow offset (8/9) and the oversized Caveat quote-mark glyph
    at 360px as composition (not punctuation). Two-column grid: the glyph
    on the left, the quote body + attribution on the right.

    The mark is rendered as a literal ASCII left double-quote in Caveat at
    360px — at this size the character functions as a decorative shape.
  */
  .pp-quote-panel {
    position: relative;
    background: var(--surface-cream);
    border: var(--border-hairline);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-pin-hero);
    padding: 60px 80px;
    display: grid;
    grid-template-columns: 1fr 1.6fr;
    gap: 60px;
    align-items: center;
    color: var(--brand-primary);
  }
  .pp-quote-panel-mark {
    font-family: "Caveat", cursive;
    font-weight: 700;
    font-size: clamp(180px, 22vw, 360px);
    line-height: 0.8;
    color: var(--brand-primary);
    margin-top: -100px;
    user-select: none;
  }
  .pp-quote-panel-body {
    font-family: "Space Grotesk", "Helvetica Neue", Arial, sans-serif;
    font-weight: 500;
    font-size: clamp(28px, 3.2vw, 50px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: var(--brand-primary);
    margin: 0;
  }
  .pp-quote-panel-attr {
    margin-top: 32px;
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--brand-primary);
  }
</style>
```
