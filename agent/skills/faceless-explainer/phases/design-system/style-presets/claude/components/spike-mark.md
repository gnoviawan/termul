```html
<div class="cl-spike-mark">
  <span class="cl-spike-glyph">&#10033;</span>
  <span class="cl-spike-name">{LABEL}</span>
</div>

<style>
  /*
    The brand mark lockup — the coral radial ✱ spike set in front of an Inter
    wordmark. The spike is the only place the brand glyph appears at scale; use it
    on a cover, a sign-off, or a brand-reveal beat. The glyph stays coral, the name
    stays ink.
  */
  .cl-spike-mark {
    display: inline-flex;
    align-items: center;
    gap: 20px;
    color: var(--brand-primary);
  }
  .cl-spike-glyph {
    font-family: "Inter", sans-serif;
    font-weight: 400;
    font-size: 120px;
    line-height: 1;
    color: var(--brand-accent);
  }
  .cl-spike-name {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 88px;
    letter-spacing: -0.02em;
    color: var(--brand-primary);
  }
</style>
```
