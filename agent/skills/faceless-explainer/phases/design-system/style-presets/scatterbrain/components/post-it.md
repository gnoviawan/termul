```html
<!-- Default sticky-note (butter variant). Apply .sky / .blush / .mint / .orange /
     .purple / .white to recolor. Add .pin (red default) or .pin-blue / .pin-green /
     .pin-gold for a thumbtack via ::before. Add .tape for a translucent tape strip
     via ::after. .pin + .tape = the "officially posted" treatment for hero stickies.
     Tilt is set via inline style or wrapper — every sticky must carry a small rotation. -->
<div class="sb-post-it pin" style="transform: rotate(var(--tilt-quiet-l));">
  <span class="sb-label">{EYEBROW}</span>
  <h3 class="sb-title">{HEADLINE}</h3>
  <p class="sb-body">{SUBHEAD}</p>
</div>

<style>
  /*
    Base sticky-note. Border-radius is forbidden — every sticky is a rectangle.
    The signature soft drop-shadow makes the sticky hover off the textured ground.
    Default fill is brand-tinted butter; six color variants cycle through the
    anchor-mixed pastels. White variant ships with a 2px ink border because pure
    white otherwise disappears into cream/paper backgrounds.

    PIN — red thumbtack via ::before at top-center. Color variants .pin-blue,
    .pin-green, .pin-gold match the sticky underneath.

    TAPE — translucent white masking-tape strip via ::after at top-center,
    rotated -2°. Combined with .pin for hero stickies.

    Tilt — apply via transform: rotate(var(--tilt-quiet-l/r)) for hero,
    --tilt-loud-l/r for accents, --tilt-wild-l/r for closing clusters.
    Alternate direction across adjacent stickies.
  */
  .sb-post-it {
    position: relative;
    padding: var(--pad-postit-md);
    box-shadow: var(--shadow-sticky);
    z-index: 1;
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
  }
  /* Color variants — gradient fills cycle through the four anchor-mixed pastels.
     Orange and purple ship flat (no gradient) for textural variety. */
  .sb-post-it.sky {
    background: linear-gradient(135deg, var(--sticky-sky) 0%, var(--sticky-sky-deep) 100%);
  }
  .sb-post-it.blush {
    background: linear-gradient(135deg, var(--sticky-blush) 0%, var(--sticky-blush-deep) 100%);
  }
  .sb-post-it.mint {
    background: linear-gradient(135deg, var(--sticky-mint) 0%, var(--sticky-mint-deep) 100%);
  }
  .sb-post-it.orange {
    background: color-mix(in srgb, var(--brand-accent) 18%, var(--anchor-peach));
  }
  .sb-post-it.purple {
    background: color-mix(in srgb, var(--brand-secondary) 18%, var(--anchor-lavender));
  }
  .sb-post-it.white {
    background: var(--photo-paper);
    border: 2px solid var(--ink-warm);
  }
  /* Padding variants */
  .sb-post-it.lg {
    padding: var(--pad-postit-lg);
  }
  .sb-post-it.sm {
    padding: var(--pad-postit-sm);
  }
  .sb-post-it.statement {
    padding: var(--pad-postit-statement);
  }

  /* Pin (::before) — default red thumbtack with radial-gradient bead highlight. */
  .sb-post-it.pin::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--pin-red-light), var(--pin-red-deep));
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }
  .sb-post-it.pin-blue::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    background: radial-gradient(
      circle at 30% 30%,
      color-mix(in srgb, var(--brand-secondary) 60%, var(--pin-blue-light)),
      color-mix(in srgb, var(--brand-secondary) 80%, var(--pin-blue-deep))
    );
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }
  .sb-post-it.pin-green::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--pin-green-light), var(--pin-green-deep));
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }
  .sb-post-it.pin-gold::before {
    content: "";
    position: absolute;
    top: var(--pin-top);
    left: 50%;
    transform: translateX(-50%);
    width: var(--pin-size);
    height: var(--pin-size);
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, var(--pin-gold-light), var(--pin-gold-deep));
    box-shadow: var(--shadow-pin);
    z-index: 10;
  }

  /* Tape (::after) — translucent white strip, rotated. Pair with .pin. */
  .sb-post-it.tape::after {
    content: "";
    position: absolute;
    top: var(--tape-top);
    left: 50%;
    transform: translateX(-50%) rotate(var(--tape-rot));
    width: var(--tape-w);
    height: var(--tape-h);
    background: var(--tape-fill);
    border: 1px solid var(--tape-edge);
    box-shadow: var(--tape-shadow);
    z-index: 10;
  }

  /* Typography inside a sticky */
  .sb-label {
    display: block;
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-warm-light);
    margin-bottom: 0.5rem;
  }
  .sb-title {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: clamp(1.75rem, 2.5vw, 2.2rem);
    line-height: 1.1;
    letter-spacing: 0.02em;
    color: var(--ink-warm);
    margin: 0 0 1rem;
  }
  .sb-body {
    font-family: "Zilla Slab", serif;
    font-size: clamp(1.5rem, 1.6vw, 1.6rem);
    font-weight: 400;
    line-height: 1.7;
    color: var(--ink-warm-light);
    margin: 0;
  }
</style>
```
