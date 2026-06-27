```html
<!-- A flow-diagram node with a triangular-arrow connector. The connector renders inline-after via a sibling span; in scene HTML, chain N nodes with N-1 connectors. Node fill cycles through the brand palette. -->
<div class="cap-diagram-row">
  <div class="cap-diagram-node">{LABEL}</div>
  <span class="cap-diagram-connector"></span>
  <div class="cap-diagram-node cap-diagram-node-alt">{LABEL}</div>
</div>

<style>
  .cap-diagram-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
  }
  .cap-diagram-node {
    border-radius: var(--cap-radius-pill, 9999px);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    background: var(--canvas);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-family: "Space Grotesk", sans-serif;
    font-weight: 600;
    font-size: 24px;
    line-height: 1.3;
    padding: 1rem 2rem;
    box-shadow: var(--cap-shadow-md, 6px 6px 0 color-mix(in srgb, var(--ink) 8%, transparent));
    min-width: 140px;
    min-height: 60px;
    z-index: 2;
  }
  .cap-diagram-node-alt {
    background: var(--brand-primary);
  }
  .cap-diagram-connector {
    width: 50px;
    height: 4px;
    background: var(--ink);
    position: relative;
    display: inline-block;
  }
  .cap-diagram-connector::after {
    content: "";
    position: absolute;
    right: -6px;
    top: 50%;
    transform: translateY(-50%);
    width: 0;
    height: 0;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
    border-left: 10px solid var(--ink);
  }
</style>
```
