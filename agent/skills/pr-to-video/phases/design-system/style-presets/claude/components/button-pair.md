```html
<div class="cl-button-pair">
  <span class="cl-btn cl-btn-primary">{LABEL}</span>
  <span class="cl-btn cl-btn-secondary">{EYEBROW}</span>
</div>

<style>
  /*
    The control vocabulary: one coral primary (the rationed voltage), one cream
    secondary with a hairline. The primary is the only coral on the scene if this
    component is the CTA moment.
  */
  .cl-button-pair {
    display: inline-flex;
    align-items: center;
    gap: 16px;
  }
  .cl-btn {
    display: inline-flex;
    align-items: center;
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 28px;
    line-height: 1;
    padding: 20px 36px;
    border-radius: var(--cl-radius-md);
  }
  .cl-btn-primary {
    background: var(--brand-accent);
    color: var(--cl-on-dark);
  }
  .cl-btn-secondary {
    background: var(--canvas);
    color: var(--brand-primary);
    border: var(--cl-border-hairline);
  }
</style>
```
