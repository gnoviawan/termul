```html
<!--
  Step number is hardcoded per variant. Pick the right variant class per position
  (bf-step-1 / bf-step-2 / bf-step-3) and match the number text inside .bf-step-num
  to the position (01 / 02 / 03).
-->
<div class="bf-timeline-step bf-step-1">
  <div class="bf-step-num">01</div>
  <h3 class="bf-step-title">{HEADLINE}</h3>
  <p class="bf-step-desc">{LEDE}</p>
  <div class="bf-step-connector"></div>
</div>

<style>
  .bf-timeline-step {
    position: relative;
    flex: 1;
    border: var(--bf-border-bold);
    padding: 32px;
    box-shadow: var(--bf-shadow-sm);
    color: var(--ink);
  }
  /* Variants — Phase 4b worker picks one per timeline position. Backgrounds
     rotate through the brand-color trio so a 3-up row reads as 3 distinct
     beats. Pair the variant class with the matching step number in markup:
     bf-step-1 → "01", bf-step-2 → "02", bf-step-3 → "03". */
  .bf-step-1 {
    background: var(--brand-primary);
  }
  .bf-step-2 {
    background: var(--brand-secondary);
  }
  .bf-step-3 {
    background: var(--brand-accent);
  }
  .bf-step-num {
    font-family: "Inter", sans-serif;
    font-weight: 900;
    font-size: 48px;
    line-height: 1;
    letter-spacing: -0.02em;
    margin-bottom: 16px;
    color: var(--ink);
    opacity: 0.6;
  }
  .bf-step-title {
    font-family: "Inter", sans-serif;
    font-weight: 700;
    font-size: 28px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    text-transform: uppercase;
    margin-bottom: 10px;
    color: var(--ink);
  }
  .bf-step-desc {
    font-family: "Inter", sans-serif;
    font-weight: 500;
    font-size: 24px;
    line-height: 1.5;
    color: var(--ink);
  }
  .bf-step-connector {
    position: absolute;
    top: 50%;
    right: -28px;
    width: 28px;
    height: 4px;
    background: var(--ink);
    transform: translateY(-50%);
    z-index: 5;
  }
</style>
```
