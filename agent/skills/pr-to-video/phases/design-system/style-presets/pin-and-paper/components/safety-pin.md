```html
<!-- The defining visual signature. Inline SVG (no external <use href> — keeps
     the scene self-contained). currentColor follows the parent's text color so
     ink-on-paper renders blue, paper-on-ink renders yellow. ALWAYS rotated
     off-axis — a pin at 0° reads as a UI icon, not a pinned object. -->
<svg class="pp-safety-pin" viewBox="0 0 360 110" width="120" height="32" aria-hidden="true">
  <g
    fill="none"
    stroke="currentColor"
    stroke-width="5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <!-- coiled spring on the right -->
    <path d="M312 38 C 296 32, 290 50, 304 58 C 320 66, 340 60, 342 44 C 344 28, 322 18, 300 24" />
    <!-- top shaft running from coil to clasp -->
    <path d="M300 24 C 240 14, 140 14, 70 30" />
    <!-- bottom shaft curving back under -->
    <path d="M312 56 C 250 78, 150 82, 80 70" />
    <!-- clasp cap (oval) covering the meet point on the left -->
    <ellipse cx="58" cy="50" rx="24" ry="14" />
  </g>
</svg>

<style>
  /*
    The closed safety pin — coil on right, shaft sweeping left, clasp cap
    on left. Default: rotated -10° to sit above a card's top edge. Inherits
    color from parent text color (currentColor on the stroke).

    Sizing presets via the `width`/`height` attribute or these utility
    classes. Position is set by the consumer scene; the pin itself just
    handles rotation.

    Variants:
      .lg   — section-divider scene oversize (rotated +14°).
      .xl   — cover-scene anchor (rotated +20°).
      .open — substitute the OPEN safety-pin path data (clasp lifted, sharp
              point exposed). For "lifted" feel vs "secured" feel — use sparingly.
  */
  .pp-safety-pin {
    color: var(--brand-primary);
    transform: rotate(var(--tilt-pin));
    transform-origin: center;
  }
  .pp-safety-pin.lg {
    width: 360px;
    height: 110px;
    transform: rotate(var(--tilt-pin-alt));
  }
  .pp-safety-pin.xl {
    width: 640px;
    height: 196px;
    transform: rotate(20deg);
  }
  /* Faded variant for layered backgrounds on section dividers. */
  .pp-safety-pin.faded {
    opacity: 0.5;
  }
</style>
```
