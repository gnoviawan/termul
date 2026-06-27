```html
<!-- The non-optional fractal-noise paper grain. MUST sit at the top of every
     scene's z-stack but below the content (pointer-events: none, z-index 1).
     Multiply blend over yellow / cream surfaces; flips to screen blend over
     ink-blue surfaces (apply .ink class). Without this layer the surface
     collapses into flat cartoon-yellow. -->
<div class="pp-paper-grain-overlay" aria-hidden="true"></div>

<style>
  /*
    Foundational atmosphere — the texture is what makes the surface read as
    physical paper under raking light, not flat color. Opacity 0.35 with
    multiply blend on default (yellow / cream) surfaces. Drops to 0.25 with
    screen blend on ink-blue surfaces — multiply on dark turns the slide
    muddy.

    Variants:
      .ink   — screen blend at 0.25 opacity (for ink-blue surfaces).
      .cream — slightly lower opacity (0.28) on cream-only scenes so the
               texture doesn't visually compete with the card layer.
  */
  .pp-paper-grain-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    opacity: 0.35;
    mix-blend-mode: multiply;
    background-image: var(--paper-grain);
  }
  .pp-paper-grain-overlay.ink {
    opacity: 0.25;
    mix-blend-mode: screen;
  }
  .pp-paper-grain-overlay.cream {
    opacity: 0.28;
  }
</style>
```
