```html
<!-- Signature decorative wallpaper layer: 5–8 candy-colored pills tilted at -25deg to +25deg, scattered absolutely behind content. Use on cover, closing, quote, and statement scenes; omit on dense data scenes. The labels are atmospheric single uppercase words. -->
<div class="cap-floats" aria-hidden="true">
  <div class="cap-float cap-float-1">VISION</div>
  <div class="cap-float cap-float-2">CREATE</div>
  <div class="cap-float cap-float-3">FUTURE</div>
  <div class="cap-float cap-float-4">BEGIN</div>
  <div class="cap-float cap-float-circle cap-float-5">NEXT</div>
  <div class="cap-float cap-float-6">LAUNCH</div>
  <div class="cap-float cap-float-circle cap-float-7">GO</div>
</div>

<style>
  .cap-floats {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .cap-float {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--cap-radius-pill, 9999px);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    color: var(--ink);
    font-family: "Space Grotesk", sans-serif;
    font-weight: 700;
    font-size: 24px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cap-float-circle {
    border-radius: 50%;
  }
  .cap-float-1 {
    width: 120px;
    height: 55px;
    top: 12%;
    left: 8%;
    transform: rotate(-12deg);
    background: var(--brand-primary);
  }
  .cap-float-2 {
    width: 160px;
    height: 60px;
    top: 18%;
    right: 12%;
    transform: rotate(8deg);
    background: var(--brand-secondary);
  }
  .cap-float-3 {
    width: 110px;
    height: 50px;
    top: 72%;
    left: 15%;
    transform: rotate(6deg);
    background: var(--brand-accent);
  }
  .cap-float-4 {
    width: 135px;
    height: 55px;
    top: 78%;
    right: 18%;
    transform: rotate(-8deg);
    background: var(--brand-primary);
  }
  .cap-float-5 {
    width: 85px;
    height: 85px;
    top: 15%;
    left: 45%;
    background: var(--brand-secondary);
  }
  .cap-float-6 {
    width: 105px;
    height: 48px;
    top: 65%;
    right: 8%;
    transform: rotate(15deg);
    background: var(--canvas);
  }
  .cap-float-7 {
    width: 90px;
    height: 90px;
    top: 75%;
    left: 5%;
    background: var(--brand-accent);
  }
</style>
```
