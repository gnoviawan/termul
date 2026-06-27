```html
<!-- Signature: 160px circular pill anchor surrounded by 4–6 candy-colored satellite pills tilted at -25deg to +25deg. The center numeral is decorative ("01"); satellites are short uppercase verbs. -->
<div class="cap-orbit">
  <div class="cap-orbit-center">01</div>
  <div class="cap-orbit-sat cap-orbit-sat-1">{LABEL}</div>
  <div class="cap-orbit-sat cap-orbit-sat-2">{LABEL}</div>
  <div class="cap-orbit-sat cap-orbit-sat-3">{LABEL}</div>
  <div class="cap-orbit-sat cap-orbit-sat-4">{LABEL}</div>
  <div class="cap-orbit-sat cap-orbit-sat-5">{LABEL}</div>
  <div class="cap-orbit-sat cap-orbit-sat-6">{LABEL}</div>
</div>

<style>
  .cap-orbit {
    position: relative;
    width: 100%;
    height: 400px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cap-orbit-center {
    width: var(--cap-orbit-size, 160px);
    height: var(--cap-orbit-size, 160px);
    border-radius: 50%;
    background: var(--brand-secondary);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Bodoni Moda", serif;
    font-size: 2.5rem;
    font-weight: 700;
    z-index: 2;
  }
  .cap-orbit-sat {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* auto-size to the label via padding — NOT a fixed width. A fixed width clips longer
       labels ("GET STARTED") past the rounded pill ends; padding lets any verb fit. */
    padding: var(--cap-pad-pill-sm, 0.4rem 1.2rem);
    border-radius: var(--cap-radius-pill, 9999px);
    border: var(--cap-outline-w, 2px) solid var(--ink);
    background: var(--canvas);
    color: var(--ink);
    font-family: "Space Grotesk", sans-serif;
    font-size: 24px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    box-shadow: var(--cap-shadow-md, 6px 6px 0 color-mix(in srgb, var(--ink) 8%, transparent));
    white-space: nowrap;
  }
  .cap-orbit-sat-1 {
    top: 10%;
    left: 20%;
    transform: rotate(-20deg);
    background: var(--brand-primary);
  }
  .cap-orbit-sat-2 {
    top: 5%;
    right: 15%;
    transform: rotate(15deg);
    background: var(--brand-secondary);
  }
  .cap-orbit-sat-3 {
    bottom: 15%;
    left: 10%;
    transform: rotate(10deg);
    background: var(--brand-accent);
  }
  .cap-orbit-sat-4 {
    bottom: 10%;
    right: 10%;
    transform: rotate(-12deg);
    background: var(--brand-primary);
  }
  .cap-orbit-sat-5 {
    top: 40%;
    left: 0%;
    transform: rotate(25deg);
    background: var(--brand-secondary);
  }
  .cap-orbit-sat-6 {
    top: 45%;
    right: 0%;
    transform: rotate(-18deg);
    background: var(--brand-accent);
  }
</style>
```
