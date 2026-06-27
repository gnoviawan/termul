```html
<!-- Decorative SVG mark for slide corners. Five variants (.circle / .squiggle /
     .triangle / .line / .cross). Place 1-2 per scene in unoccupied corners. All
     variants render at 0.15 opacity with a 3px ink-warm stroke. -->
<svg class="sb-doodle sb-doodle-circle" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" />
</svg>
<svg class="sb-doodle sb-doodle-squiggle" viewBox="0 0 120 60">
  <path d="M10 30 Q30 10, 50 30 T90 30" />
</svg>
<svg class="sb-doodle sb-doodle-triangle" viewBox="0 0 60 60">
  <polygon points="30,5 55,45 5,45" />
</svg>
<svg class="sb-doodle sb-doodle-line" viewBox="0 0 120 50">
  <line x1="10" y1="25" x2="110" y2="25" stroke-linecap="round" />
</svg>
<svg class="sb-doodle sb-doodle-cross" viewBox="0 0 100 100">
  <path d="M50 10 L50 90 M10 50 L90 50" stroke-linecap="round" />
</svg>

<style>
  /*
    Decorative SVG mark — circle, squiggle, triangle, line, or cross. All render
    in 3px ink-warm stroke at 0.15 opacity. Phase 4b: position absolutely in 1-2
    unoccupied corners per scene; drift ±2° around center on sine.inOut (~3s
    loop) for ambient motion. Never animate the stickies themselves.

    Use 1-2 doodles per scene maximum. Three or more clutters the margin.
  */
  .sb-doodle {
    position: absolute;
    opacity: var(--doodle-opacity);
    pointer-events: none;
    z-index: 0;
    fill: none;
    stroke: var(--ink-warm);
    stroke-width: var(--doodle-stroke);
  }
  /* Default sizes — override per-instance via inline style */
  .sb-doodle-circle {
    width: 100px;
    height: 100px;
  }
  .sb-doodle-squiggle {
    width: 120px;
    height: 60px;
  }
  .sb-doodle-triangle {
    width: 60px;
    height: 60px;
  }
  .sb-doodle-line {
    width: 120px;
    height: 50px;
  }
  .sb-doodle-cross {
    width: 80px;
    height: 80px;
  }
  /* Optional brand-tinted variant for accent moments (use sparingly) */
  .sb-doodle.tinted {
    stroke: var(--brand-primary);
  }
</style>
```
