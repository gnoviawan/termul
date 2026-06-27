```html
<div class="sb-bg-warm"></div>

<style>
  /*
    Warm-gradient background. Cream base with soft-glow ellipses tinted by the
    brand's anchor palette (butter / sky / blush) suggesting morning light. Use
    on opening, closing, or atmospheric pivot scenes. One of three required
    background variants. Glow ellipse colors mix brand DNA into the anchor hues
    so the warm light follows the brand.
  */
  .sb-bg-warm {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background:
      radial-gradient(
        ellipse at 30% 20%,
        color-mix(in srgb, var(--brand-primary) 18%, var(--anchor-butter)) 0%,
        transparent 50%
      ),
      radial-gradient(
        ellipse at 70% 80%,
        color-mix(in srgb, var(--brand-secondary) 18%, var(--anchor-sky)) 0%,
        transparent 50%
      ),
      radial-gradient(
        ellipse at 50% 50%,
        color-mix(in srgb, var(--brand-accent) 18%, var(--anchor-blush)) 0%,
        transparent 60%
      ),
      linear-gradient(160deg, var(--paper-cream) 0%, var(--paper-cream-deep) 100%);
    /* Glow ellipses are at low effective opacity via the radial transparent stops;
       the brand-tinted anchors keep the morning-light register on-brand. */
  }
</style>
```
