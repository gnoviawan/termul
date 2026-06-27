```html
<p class="cl-text-statement">{HEADLINE} <a class="cl-text-link">{LABEL}</a>{SUBHEAD}</p>

<style>
  /*
    A Fraunces statement carrying the system's most distinctive small detail — the
    coral inline link (one-pixel-feel underline, coral text). The link is the ONE
    coral moment in the scene. {HEADLINE} is the run before the link, {LABEL} the
    linked phrase, {SUBHEAD} the run after (end with a period there, or leave empty).
  */
  .cl-text-statement {
    font-family: "Fraunces", "Tiempos Headline", Garamond, serif;
    font-weight: 400;
    font-size: clamp(48px, 5vw, 88px);
    line-height: 1.18;
    letter-spacing: -0.02em;
    color: var(--brand-primary);
    margin: 0;
    max-width: 26ch;
  }
  .cl-text-link {
    color: var(--brand-accent);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 6px;
  }
</style>
```
