```html
<article class="cl-editorial">
  <div class="cl-editorial-head">
    <span class="cl-editorial-kicker"
      ><span class="cl-editorial-spike">&#10033;</span> {EYEBROW}</span
    >
    <h2 class="cl-editorial-title">{HEADLINE}</h2>
  </div>
  <div class="cl-editorial-body">
    <p class="cl-editorial-lede"><span class="cl-editorial-dropcap">{LETTER}</span>{LEDE}</p>
    <p class="cl-editorial-col">{SUBHEAD}</p>
    <aside class="cl-editorial-margin">{QUOTE}</aside>
  </div>
</article>

<style>
  /*
    The long-form essay pattern — three voices in one scene. A mono kicker + Fraunces
    headline up top; then a Fraunces lede with a coral dropcap, an Inter body column,
    and a Fraunces-italic margin note set off by a hairline rule. For text-led scenes
    that want to read as considered prose, not bullet points.
  */
  .cl-editorial {
    background: var(--canvas);
    border: var(--cl-border-hairline);
    border-radius: var(--cl-radius-lg);
    padding: 64px;
    color: var(--brand-primary);
  }
  .cl-editorial-head {
    border-bottom: var(--cl-border-hairline);
    padding-bottom: 32px;
    margin-bottom: 40px;
  }
  .cl-editorial-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--cl-ink-muted);
    margin-bottom: 24px;
  }
  .cl-editorial-spike {
    color: var(--brand-accent);
    font-size: 26px;
  }
  .cl-editorial-title {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(56px, 6vw, 112px);
    line-height: 1;
    letter-spacing: -0.028em;
    color: var(--brand-primary);
    margin: 0;
    max-width: 18ch;
  }
  .cl-editorial-title em {
    font-style: italic;
    color: var(--brand-accent);
  }
  .cl-editorial-body {
    display: grid;
    grid-template-columns: 1.2fr 1fr 1fr;
    gap: 48px;
    align-items: start;
  }
  .cl-editorial-lede {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: 38px;
    line-height: 1.2;
    letter-spacing: -0.012em;
    color: var(--cl-ink-strong);
    margin: 0;
  }
  .cl-editorial-dropcap {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: 132px;
    line-height: 0.8;
    letter-spacing: -0.04em;
    color: var(--brand-accent);
    float: left;
    margin: 10px 16px 0 0;
  }
  .cl-editorial-col {
    font-family: "Inter", sans-serif;
    font-weight: 400;
    font-size: 26px;
    line-height: 1.6;
    color: var(--cl-ink-body);
    margin: 0;
  }
  .cl-editorial-margin {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-style: italic;
    font-size: 30px;
    line-height: 1.25;
    letter-spacing: -0.01em;
    color: var(--brand-primary);
    border-left: 2px solid var(--brand-accent);
    padding-left: 24px;
  }
</style>
```
