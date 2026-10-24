# Termul design system canvas

A pan-and-zoom canvas of Termul's real tokens and components, rendered from `src/renderer`.
It only uses mock data and makes no network requests.

```sh
bun run design:dev        # local dev server
bun run design:build      # static build to design-system/dist
bun run typecheck:design
```

- Registry: `src/registry/index.tsx`. Every entry is a typed `CanvasEntry`, grouped into sections and columns.
- Previews: `src/previews/*`. These import production components and never fork them.
- Themes: the toolbar selector calls the real `applyColorTheme`.
- Layout: item positions and the camera persist in localStorage (`termul.design-system-canvas.layout`, v1). **Reset layout** clears them.

Keys: arrows pan · `+`/`-` zoom · `F` fit all · `0` reset · on a focused grip, arrows move the item (hold Shift for bigger steps).

## Smoke tests (real Chrome)

```sh
bun run playwright install chromium   # once
bun run test:smoke:canvas
```

`design-system/smoke/` starts its own canvas dev server (port 5198, or `CANVAS_SMOKE_PORT`) and checks, for every registry entry:

- the canvas loads with no console errors or uncaught exceptions,
- each entry is on the canvas and its preview renders,
- every button's accessible name, as Chrome computes it, has no space before a comma or period and no edge whitespace.

Accessible names are read from Chrome's accessibility tree (`helpers/ax-name.ts`), not jsdom. jsdom ignores layout, so it cannot catch a name Chrome changes because of CSS, like the stray space an absolutely positioned `sr-only` span added in #1512.

`getFullAXTree` only sees rendered nodes, so a check on content inside a closed popover or flyout must open it first.
If `/\s[,.]/` ever flags a legitimate name such as "Loading ...", narrow the regex; don't delete the test.
