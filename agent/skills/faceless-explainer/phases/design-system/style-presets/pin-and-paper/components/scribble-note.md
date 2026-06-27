```html
<p class="pp-scribble-note">
  <!-- TODO: wrap a word in <span class="pp-underline">word</span> for handwritten
       emphasis (2px solid ink underline). Use sparingly — once per scribble. -->
  {QUOTE}
</p>

<style>
  /*
    Caveat hand-script marginal note — the system's "me" voice. Rotated -2°
    by default for the "handwritten in the margin" feel. May be appended to
    a pp-pinned-card body, placed in a slide's lower-right corner, or used
    as a standalone scribble on a section divider.

    The .pp-underline span draws a 2px solid ink underline — mimics an
    underline drawn by hand for emphasis. NEVER use this on Space Grotesk
    body text; underline is exclusively a Caveat treatment in this preset.

    Variants:
      .sm  — small in-card annotation (~28px).
      .lg  — section-divider scribble (~50px).
      .right — right-aligned + right-bottom transform origin (cover scene).
  */
  .pp-scribble-note {
    font-family: "Caveat", cursive;
    font-weight: 600;
    font-size: clamp(28px, 2.4vw, 38px);
    line-height: 1.05;
    color: var(--brand-primary);
    transform: rotate(var(--tilt-scribble));
    transform-origin: left bottom;
    margin: 0;
    padding-top: 14px;
    max-width: 32ch;
  }
  .pp-scribble-note.sm {
    font-size: clamp(28px, 2vw, 32px);
  }
  .pp-scribble-note.lg {
    font-size: clamp(38px, 3.2vw, 50px);
  }
  .pp-scribble-note.right {
    text-align: right;
    transform-origin: right bottom;
  }
  /* Inline emphasis span — 2px solid ink underline, hand-drawn feel. */
  .pp-scribble-note .pp-underline {
    border-bottom: 2px solid var(--brand-primary);
  }
</style>
```
