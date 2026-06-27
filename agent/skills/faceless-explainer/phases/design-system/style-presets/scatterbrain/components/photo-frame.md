```html
<div class="sb-photo-frame pin tape" style="transform: rotate(var(--tilt-quiet-l));">
  <div class="sb-photo-frame-inner">
    <span class="sb-photo-frame-placeholder">{LABEL}</span>
  </div>
  <p class="sb-photo-frame-caption">{SUBHEAD}</p>
</div>

<style>
  /*
    Polaroid-style image frame. White paper with 1rem padding around a 4:3 inner
    image area. Same drop shadow as post-its; small rotation. Optional Caveat
    caption beneath the photo for a hand-written annotation. Used when a scene
    needs an image-anchor — product screenshot, customer photo, logo lockup.

    Hero / spotlight usage adds both .pin and .tape. Photo-only usage drops .tape.
  */
  .sb-photo-frame {
    position: relative;
    display: inline-block;
    background: var(--photo-paper);
    padding: 1rem;
    box-shadow: var(--shadow-sticky);
    z-index: 1;
  }
  .sb-photo-frame.pin::before {
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
  .sb-photo-frame.tape::after {
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
  .sb-photo-frame-inner {
    width: 100%;
    aspect-ratio: 4 / 3;
    background:
      radial-gradient(
        circle at 40% 40%,
        color-mix(in srgb, var(--brand-primary) 30%, transparent) 0%,
        transparent 50%
      ),
      radial-gradient(
        circle at 60% 60%,
        color-mix(in srgb, var(--brand-secondary) 30%, transparent) 0%,
        transparent 50%
      ),
      linear-gradient(
        135deg,
        var(--photo-placeholder-1) 0%,
        var(--photo-placeholder-2) 50%,
        var(--photo-placeholder-3) 100%
      );
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .sb-photo-frame-placeholder {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 1.5rem;
    color: var(--ink-warm-light);
    opacity: 0.4;
  }
  .sb-photo-frame-caption {
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 500;
    line-height: 1.3;
    color: var(--ink-warm);
    text-align: center;
    margin: 0.75rem 0 0;
  }
</style>
```
