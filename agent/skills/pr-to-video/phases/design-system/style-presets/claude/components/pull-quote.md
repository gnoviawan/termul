```html
<figure class="cl-pull-quote">
  <blockquote class="cl-pull-quote-text">{QUOTE}</blockquote>
  <figcaption class="cl-pull-quote-cite">{AUTHOR}</figcaption>
</figure>

<style>
  /*
    The editorial pull-quote — Fraunces italic, the only place a long line is
    allowed to breathe across a scene. Ink on cream, a small Inter uppercase cite
    below. No quotation-mark glyphs needed; the italic serif carries the voice.
  */
  .cl-pull-quote {
    margin: 0;
    max-width: 24ch;
  }
  .cl-pull-quote-text {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-style: italic;
    font-size: clamp(48px, 6vw, 108px);
    line-height: 1.12;
    letter-spacing: -0.018em;
    color: var(--cl-ink-strong);
    margin: 0;
  }
  .cl-pull-quote-cite {
    display: block;
    margin-top: 32px;
    font-family: "Inter", sans-serif;
    font-style: normal;
    font-weight: 500;
    font-size: 28px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cl-ink-muted);
  }
  .cl-pull-quote-cite::before {
    content: "";
    display: inline-block;
    width: 40px;
    height: 2px;
    background: var(--brand-accent);
    vertical-align: middle;
    margin-right: 16px;
  }
</style>
```
