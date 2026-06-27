```html
<div class="bf-dot-grid-bg"></div>

<style>
  .bf-dot-grid-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background-color: var(--canvas);
    background-image: radial-gradient(
      circle,
      var(--ink) var(--bf-dot-radius),
      transparent var(--bf-dot-radius)
    );
    background-size: var(--bf-dot-size) var(--bf-dot-size);
    opacity: 0.35;
    pointer-events: none;
    z-index: 0;
  }
</style>
```
