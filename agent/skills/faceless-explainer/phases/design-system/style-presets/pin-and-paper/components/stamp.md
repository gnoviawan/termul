```html
<span class="pp-stamp">{LABEL}</span>

<style>
  /*
    Cinnabar-red rotated rubber-stamp tag — one of exactly TWO places red
    appears in this system (the other is the pp-pill-yes negative variant).
    3px solid brand-accent border, brand-accent mono uppercase text,
    rotation locked at -4°. Zero radius — stamps don't have soft corners.

    Variants:
      .lg — slightly larger padding + font (for cover-scene status marks).
      .upright — emergency override that drops rotation to 0° for cases where
                 the stamp must sit flush against another rotated element.
                 Use sparingly; the -4° tilt is the identity.

    DO NOT counter-rotate the stamp on entry animations. The stamp-slam
    motion scales 1.08 → 1 at -4°; it never rotates from 0° to -4°.
  */
  .pp-stamp {
    display: inline-block;
    border: var(--border-stamp);
    color: var(--brand-accent);
    background: transparent;
    padding: 6px 16px;
    font-family: "DM Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 26px;
    line-height: 1;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    transform: rotate(var(--tilt-stamp));
    border-radius: 0;
  }
  .pp-stamp.lg {
    padding: 8px 20px;
    font-size: 30px;
    letter-spacing: 0.2em;
  }
  .pp-stamp.upright {
    transform: rotate(0deg);
  }
</style>
```
