```html
<div class="cl-hero">
  <span class="cl-hero-kicker"><span class="cl-hero-spike">&#10033;</span> {EYEBROW}</span>
  <h1 class="cl-hero-display">{HEADLINE}</h1>
  <p class="cl-hero-lede">{SUBHEAD}</p>
  <span class="cl-hero-cta">{LABEL}</span>
</div>

<style>
  /*
    Editorial cover hero on the warm cream floor. JetBrains Mono kicker with the
    coral ✱ spike above; a large Fraunces sentence-case headline (the "serif that
    thinks"); an Inter lede; one rationed coral CTA. The whole block left-aligned,
    generous cream around it. Prefix: cl- (claude). For an italic emphasis word in
    the headline, wrap it in <em> (Fraunces italic, coral).
  */
  .cl-hero {
    background: var(--canvas);
    padding: 96px 80px;
    color: var(--brand-primary);
    max-width: 24ch;
  }
  .cl-hero-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--cl-ink-muted);
    margin-bottom: 32px;
  }
  .cl-hero-spike {
    color: var(--brand-accent);
    font-size: 30px;
  }
  .cl-hero-display {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(72px, 9vw, 168px);
    line-height: 0.98;
    letter-spacing: -0.035em;
    color: var(--brand-primary);
    margin: 0;
  }
  .cl-hero-display em {
    font-style: italic;
    color: var(--brand-accent);
  }
  .cl-hero-lede {
    font-family: "Inter", sans-serif;
    font-weight: 400;
    font-size: clamp(28px, 2.2vw, 36px);
    line-height: 1.5;
    color: var(--cl-ink-body);
    margin: 32px 0 0;
    max-width: 34ch;
  }
  .cl-hero-cta {
    display: inline-block;
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 28px;
    line-height: 1;
    color: var(--cl-on-dark);
    background: var(--brand-accent);
    padding: 20px 36px;
    border-radius: var(--cl-radius-md);
    margin-top: 40px;
  }
</style>
```
