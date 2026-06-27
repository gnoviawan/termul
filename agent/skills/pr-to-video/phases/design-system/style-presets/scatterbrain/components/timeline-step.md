```html
<!-- One step in a phased narrative. Pair a colored node sticky with a white
     content sticky; the "rail" between them lives at the scene-layout level,
     NOT inside this component (rails are UI chrome, dropped per §8.3). -->
<div class="sb-timeline-step">
  <div class="sb-timeline-step-node pin" style="transform: rotate(var(--tilt-quiet-l));">
    <h3 class="sb-timeline-step-node-title">{HEADLINE}</h3>
    <p class="sb-timeline-step-node-phase">{LABEL}</p>
  </div>
  <div class="sb-timeline-step-body" style="transform: rotate(var(--tilt-quiet-r));">
    <p class="sb-timeline-step-body-text">{SUBHEAD}</p>
  </div>
</div>

<style>
  /*
    Step card carrying a narrative beat ("Phase One — Foundation"). Two stickies
    per step: a colored node sticky (Shrikhand phase title + Caveat phase label)
    and a white-bordered content sticky (Zilla Slab body copy). Designed to be
    used in a vertical stack of 3-5 steps; adjacent steps should swap node-color
    and alternate tilt direction.

    The original template ships a dashed-bezier SVG connector between node and
    body. That rail is dropped from this preset per §8.3 (UI chrome — no
    scene-level use); add it back in scene HTML if needed.
  */
  .sb-timeline-step {
    display: flex;
    align-items: stretch;
    gap: 2rem;
    margin-bottom: 2rem;
  }
  .sb-timeline-step-node {
    position: relative;
    padding: var(--pad-postit-md);
    min-width: 200px;
    text-align: center;
    box-shadow: var(--shadow-sticky);
    background: linear-gradient(135deg, var(--sticky-butter) 0%, var(--sticky-butter-deep) 100%);
    display: flex;
    flex-direction: column;
    justify-content: center;
    z-index: 1;
  }
  .sb-timeline-step-node.sky {
    background: linear-gradient(135deg, var(--sticky-sky) 0%, var(--sticky-sky-deep) 100%);
  }
  .sb-timeline-step-node.mint {
    background: linear-gradient(135deg, var(--sticky-mint) 0%, var(--sticky-mint-deep) 100%);
  }
  .sb-timeline-step-node.blush {
    background: linear-gradient(135deg, var(--sticky-blush) 0%, var(--sticky-blush-deep) 100%);
  }
  .sb-timeline-step-node.pin::before {
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
  .sb-timeline-step-node-title {
    font-family: "Shrikhand", cursive;
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.1;
    letter-spacing: 0.02em;
    color: var(--ink-warm);
    margin: 0 0 0.5rem;
  }
  .sb-timeline-step-node-phase {
    font-family: "Caveat", cursive;
    font-size: 1.5rem;
    font-weight: 500;
    line-height: 1.3;
    color: var(--ink-warm-light);
    margin: 0;
  }
  /* Content sticky — white with ink border so it reads as "plain note" */
  .sb-timeline-step-body {
    flex: 1;
    padding: var(--pad-postit-md);
    background: var(--photo-paper);
    border: 2px solid var(--ink-warm);
    box-shadow: var(--shadow-sticky);
    z-index: 1;
  }
  .sb-timeline-step-body-text {
    font-family: "Zilla Slab", serif;
    font-size: clamp(1.5rem, 1.6vw, 1.6rem);
    font-weight: 400;
    line-height: 1.7;
    color: var(--ink-warm-light);
    margin: 0;
  }
</style>
```
