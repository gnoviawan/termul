```html
<div class="sb-bg-paper"></div>

<style>
  /*
    Desk-paper background. Cream gradient with a faint 40px grid overlay
    suggesting graph or notebook paper. Use on "desk surface" scenes — focused
    statements, single hero stickies, content that needs to read calmly. One of
    three required background variants.
  */
  .sb-bg-paper {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: linear-gradient(180deg, var(--paper-cream) 0%, var(--paper-cream-deep) 100%);
  }
  .sb-bg-paper::after {
    /* 40px graph-paper grid at low opacity */
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(var(--paper-grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--paper-grid-line) 1px, transparent 1px);
    background-size: 40px 40px;
  }
</style>
```
