```html
<div class="cl-coral-callout">
  <span class="cl-coral-kicker"><span class="cl-coral-spike">&#10033;</span> {EYEBROW}</span>
  <p class="cl-coral-quote">{QUOTE}</p>
  <div class="cl-coral-foot">
    <span class="cl-coral-meta">{LABEL}</span>
    <span class="cl-coral-cta">{SUBHEAD}</span>
  </div>
</div>

<style>
  /*
    The full-bleed coral "voltage" band — used ONCE per video, the loudest moment
    in the system. Cream text on coral, a single Fraunces statement, a cream CTA
    chip. Because coral is rationed, a scene with this callout carries no other
    coral. <em> inside the quote = a recessed cream italic.
  */
  .cl-coral-callout {
    background: var(--brand-accent);
    color: var(--cl-on-dark);
    padding: 80px;
    display: flex;
    flex-direction: column;
    gap: 40px;
    border-radius: var(--cl-radius-lg);
  }
  .cl-coral-kicker {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--cl-on-dark) 82%, var(--brand-accent));
  }
  .cl-coral-spike {
    color: var(--cl-on-dark);
    font-size: 26px;
  }
  .cl-coral-quote {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(56px, 7vw, 132px);
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--cl-on-dark);
    margin: 0;
    max-width: 20ch;
  }
  .cl-coral-quote em {
    font-style: italic;
    color: color-mix(in srgb, var(--cl-on-dark) 72%, var(--brand-accent));
  }
  .cl-coral-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    border-top: 1px solid color-mix(in srgb, var(--cl-on-dark) 24%, transparent);
    padding-top: 32px;
  }
  .cl-coral-meta {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--cl-on-dark) 85%, var(--brand-accent));
  }
  .cl-coral-cta {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 28px;
    line-height: 1;
    color: var(--brand-primary);
    background: var(--canvas);
    padding: 18px 32px;
    border-radius: var(--cl-radius-md);
  }
</style>
```
