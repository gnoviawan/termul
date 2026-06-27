```html
<!--
  Feature-icon letter is hardcoded. When rendering N>1 feature-card instances in one scene,
  manually cycle the `bf-feature-icon-*` class (a / b / c) and the letter inside the div (A / B / C).
-->
<div class="bf-feature-card">
  <div class="bf-feature-deco-notch"></div>
  <div class="bf-feature-icon bf-feature-icon-a">A</div>
  <h3 class="bf-feature-title">{HEADLINE}</h3>
  <p class="bf-feature-body">{LEDE}</p>
</div>

<style>
  .bf-feature-card {
    position: relative;
    border: var(--bf-border-bold);
    background: var(--canvas);
    padding: var(--bf-pad-card);
    box-shadow: var(--bf-shadow);
    color: var(--ink);
  }
  .bf-feature-deco-notch {
    position: absolute;
    top: -12px;
    right: 24px;
    width: 48px;
    height: 48px;
    border: var(--bf-border-mid);
    background: var(--brand-accent);
  }
  .bf-feature-icon {
    width: 64px;
    height: 64px;
    border: var(--bf-border-mid);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 24px;
    font-family: "Inter", sans-serif;
    font-weight: 700;
    font-size: 28px;
    text-transform: uppercase;
    color: var(--ink);
  }
  /* Variants for multi-instance scenes — pick a/b/c per card so a 3-up row reads as 3 distinct icons. */
  .bf-feature-icon-a {
    background: var(--brand-primary);
  }
  .bf-feature-icon-b {
    background: var(--brand-secondary);
  }
  .bf-feature-icon-c {
    background: var(--brand-accent);
  }
  .bf-feature-title {
    font-family: "Inter", sans-serif;
    font-weight: 700;
    font-size: 28px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin-bottom: 14px;
    color: var(--ink);
  }
  .bf-feature-body {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 24px;
    line-height: 1.6;
    color: var(--ink);
    opacity: 0.85;
  }
</style>
```
