```html
<div class="sb-bg-cork"></div>

<style>
  /*
    Cork-board background. Warm tan/brown tonal gradient with a faint pattern of
    small plus-sign marks suggesting cork texture. Use on "wall of pinned notes"
    scenes (hero clusters, feature grids, comparisons). One of three required
    background variants — every scene MUST use bg-cork, bg-paper, or bg-warm.
  */
  .sb-bg-cork {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background:
      radial-gradient(ellipse at 20% 30%, var(--cork-glow-warm) 0%, transparent 50%),
      radial-gradient(ellipse at 80% 70%, var(--cork-glow-deep) 0%, transparent 40%),
      linear-gradient(135deg, var(--cork-light) 0%, var(--cork-mid) 50%, var(--cork-deep) 100%);
  }
  .sb-bg-cork::after {
    /* Plus-sign pattern overlay — cork's tiny holes */
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23b8a088' fill-opacity='0.15'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
    opacity: 0.5;
  }
</style>
```
