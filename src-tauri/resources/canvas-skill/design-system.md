# Design systems

Colour and type tokens, text styles, and reusable components with variants, laid out so a person can read them.

## Order of work

1. **Variables first.** Pick a style with `get_canvas_style` and run its `apply` batch, or create a collection with `Light` and `Dark` modes yourself. Name variables by role, not by colour: `color/primary`, not `color/purple`.
2. **Text styles.** For each step of the type scale, create a text layer with its size, face, line height and letter spacing, then `style.create` with `{"type": "text", "name": "Heading/H1", "from": textId}`.
3. **Components.** Build each component with auto layout, bind its fills and strokes to variables, and turn it into a component. Make variants where states differ.
4. **Documentation frames.** Lay out what you made on frames a person can read: swatches with names and values, the type scale as sample lines, each component with its variants side by side.

## Naming

- Use slash paths to group: `color/bg`, `space/3`, `Heading/H1`, `Button/Primary`.
- Variant properties are short words: `Type` = `Primary` or `Secondary`, `Size` = `Small` or `Large`, `State` = `Default` or `Disabled`.

## Components worth making first

- **Button**: horizontal auto layout, `sizingH: "hug"`, padding `[12, 20, 12, 20]`, the style's medium radius, a text label. Variants for `Primary` (filled `primary`, label `onPrimary`), `Secondary` (stroke `border`, label `text`) and `Disabled`.
- **Input**: a vertical frame with a label and a field frame with a `border` stroke; variants for `Default`, `Focus` (stroke `primary`) and `Error`.
- **Card**: a vertical frame with padding 24, `surface` fill and the medium radius; expose its title and body as text properties.
- **List row**, **tag** and **nav item** when the product needs them.

To make variants, build two or more components, then `run_command` with `component.combineVariants` and their ids. `component.addVariant` duplicates a variant and names the new one with `property` and `value`.

This batch creates a heading text style and a button component bound to variables:

```json canvas-batch
{
  "label": "Heading style and button",
  "commands": [
    { "command": "variable.createCollection", "params": { "name": "Core", "modes": ["Light", "Dark"] } },
    { "command": "variable.create", "params": { "collection": "Core", "name": "color/primary", "type": "color", "values": { "Light": "#4338CA", "Dark": "#8B87F5" } } },
    { "command": "variable.create", "params": { "collection": "Core", "name": "color/onPrimary", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#0B1020" } } },
    { "command": "node.create", "as": "h1", "params": { "type": "text", "name": "H1 sample", "text": "Heading 1", "props": { "fontSize": 44, "fontStyle": "Semi Bold", "lineHeight": 52, "letterSpacing": "-2%", "fill": "#0F172A" } } },
    { "command": "style.create", "params": { "type": "text", "name": "Heading/H1", "from": { "$ref": "h1" } } },
    { "command": "node.create", "as": "button", "params": { "type": "component", "name": "Button/Primary", "x": 0, "y": 120, "props": { "layout": "horizontal", "sizingH": "hug", "sizingV": "hug", "padding": [12, 20, 12, 20], "cornerRadius": 10 } } },
    { "command": "node.create", "as": "label", "params": { "type": "text", "name": "Label", "parent": { "$ref": "button" }, "text": "Mulai gratis", "props": { "fontSize": 16, "fontStyle": "Semi Bold" } } },
    { "command": "variable.bind", "params": { "ids": [{ "$ref": "button" }], "field": "fill", "variable": "color/primary" } },
    { "command": "variable.bind", "params": { "ids": [{ "$ref": "label" }], "field": "fill", "variable": "color/onPrimary" } }
  ]
}
```

## Documentation layout

- One frame per topic ("Colours", "Type", "Buttons"), 1440 wide, side by side.
- Swatches: a row of squares (96 × 96, small radius) with the token name and hex value under each, in both modes if the collection has them.
- Type scale: one line per text style, set in that style, with its name and size beside it in `small` and `muted`.
- Components: each variant in a row with its name above it.

## Avoid

- Tokens named after values (`blue-500`, `16px`); a theme change then makes the names lie.
- Components built from absolutely positioned layers. Without auto layout they break as soon as a label changes.
- Text styles that differ by one unit of size. Keep a clear step between levels.
