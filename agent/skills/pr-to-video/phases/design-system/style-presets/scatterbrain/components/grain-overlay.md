```html
<div class="sb-grain-overlay"></div>

<style>
  /*
    Fixed full-viewport SVG fractal-noise grain at 4% opacity. Sits above all
    content (high z-index) but does not block pointer events. Reinforces the
    paper-and-cork tactile register. MUST be present on every scene — without
    it the deck loses its paper voice and reads as a flat web layout.
  */
  .sb-grain-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    opacity: 0.04;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 200px 200px;
  }
</style>
```
