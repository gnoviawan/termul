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
