# Canvas basics

How the canvas engine behaves, in the terms its tools use. Every property name here is a `set_properties` key or a command parameter; unknown keys are an error.

## Coordinates and layers

- The page is measured in page units: 1 unit is 1 pixel at 100% zoom, `x` grows to the right and `y` grows downwards.
- `x` and `y` in `create_node` and `set_properties` are relative to the parent frame, or to the page when there is no parent. Groups do not count as parents for coordinates.
- `inspect_document` and `get_node` report `x` and `y` relative to the parent and `absoluteBounds` in page coordinates.
- Layer types: `frame`, `rectangle`, `ellipse`, `polygon`, `star`, `line`, `arrow`, `text`, `vector`, `section`, `component`, `slice`.
- Before you place a new top-level frame, call `inspect_document` with `depth` 1 and put the new frame to the right of what is already there, with a gap of about 120.

## Frames and their defaults

A new frame has a white fill, clips its content (`clip: true`) and has a fixed width and height, even when you give it a `layout`. Change what you do not want:

- A frame that only arranges its children usually needs `"fills": []` so it does not paint a white box over its parent's background.
- A section or a card whose height should follow its content needs `"sizingV": "hug"`. With the default fixed height, content that grows is cut off by the clip.

`frame.create` takes a `preset` for common sizes, for example `run_command` with `{"command": "frame.create", "params": {"preset": "iPhone 16", "name": "Sign in"}}`. Useful presets: `iPhone 16` (393 × 852), `Android Compact` (412 × 917), `Desktop` (1440 × 1024), `Slide 16:9` (1920 × 1080), `Instagram post` (1080 × 1350), `Instagram story` (1080 × 1920), `LinkedIn post` (1200 × 1200), `YouTube thumbnail` (1280 × 720) and `A4` (595 × 842). `run_command` with `frame.presets` lists them all.

## Auto layout

Set `layout` on a frame, component or instance to `horizontal`, `vertical` or `grid`. Its children are then placed by the layout, and their own `x` and `y` are ignored.

| Key | Values |
| --- | --- |
| `gap` | Space between children along the layout direction. |
| `padding` | One number, or `[top, right, bottom, left]`. |
| `mainAlign` | `min`, `center`, `max`, or the automatic gaps `spaceBetween`, `spaceAround` and `spaceEvenly`. |
| `crossAlign` | `min`, `center`, `max`, or `baseline` in horizontal layouts. |
| `wrap` | `true` makes a horizontal layout flow onto more rows (use `crossGap` for the space between rows). |
| `gridColumns`, `gridRows`, `columnTracks`, `rowTracks` | For `layout: "grid"`; tracks take numbers, `"1fr"` or `"auto"`. |
| `absolute` | `true` takes one child out of the layout so you can place it with `x` and `y`, for a badge or a decoration. |

## Sizing

Every layer has `sizingH` and `sizingV`, each `fixed`, `hug` or `fill`.

- `fixed` keeps the `width` or `height` you set.
- `hug` shrinks or grows to fit the content. Use it for buttons, tags, sections and cards.
- `fill` stretches to the space the parent's layout gives it. Use it for section frames inside a page, for columns that share a row, and for wrapping text.

Three traps break most layouts:

1. `fill` needs an auto layout parent. On a layer whose parent has no `layout`, the call fails with "Fill needs an auto layout parent".
2. A `fill` child inside a `hug` parent has nothing to fill. The child shrinks to a width of 0 and the parent collapses around its padding. Give the parent a real width: `fixed`, or `fill` inside its own auto layout parent.
3. Text that hugs its content does not wrap. Put a long sentence in a narrow frame and it runs past the edge and is cut off by the frame's clip.

Use `minWidth`, `maxWidth`, `minHeight` and `maxHeight` to bound a `hug` or `fill` layer. `maxWidth` on a paragraph keeps its lines readable on a wide page.

## Text

A new text layer is 12 units, black, Inter Regular, and grows in both directions to fit its characters (`textAutoResize: "widthAndHeight"`). For real designs, always set at least `fontSize`, `fontStyle` and `fill`.

- `textAutoResize`: `widthAndHeight` for short labels that never wrap; `height` for anything that may wrap (needs a fixed width or `sizingH: "fill"`); `none` for a fixed box; `truncate` for one line that ends in an ellipsis.
- A text layer created with a `width` wraps at that width and grows in height.
- `lineHeight` takes `"auto"`, a number of units, or a percentage such as `"140%"`. Set it for paragraphs: about 1.5 times the font size for body text and 1.05 to 1.2 times for big headlines.
- `letterSpacing` takes units or a percentage such as `"-2%"`. Tighten large headlines a little and space out small uppercase labels.
- `textAlign`: `left`, `center`, `right` or `justified`. `textCase`: `original`, `upper`, `lower`, `title` or `smallCaps`.
- `maxLines` caps the number of lines; `features` switches OpenType features, for example `{"tnum": true}` for table figures.

### Fonts

The canvas renders one family today: **Inter**, in the faces `Regular`, `Italic`, `Semi Bold` and `Bold`.

- Any other `fontFamily` falls back to the default face without an error, so the design will not look the way you planned. The `warnings` in the result name the family that is not installed.
- A `fontStyle` such as `Medium` or `Light` draws in the nearest face. The `warnings` in the result tell you when the face has another weight than the name asks for.
- Build contrast from size, weight (`Regular` against `Semi Bold` or `Bold`), case and letter spacing, not from a second family.
- Inter covers Latin letters with accents, digits and common punctuation. Emoji and most symbols have no glyph and do not draw, so write labels in words and draw simple icons from shapes.

## Colour, strokes and effects

- Colours are `"#RRGGBB"` or `"#RRGGBBAA"`. `fill` sets one solid fill; `fills` takes an array of paints, and `[]` removes every fill.
- Gradients: `{"type": "linearGradient", "stops": ["#hex", "#hex"]}`, and `radialGradient` likewise. Use them rarely.
- `stroke` sets one stroke colour, with `strokeWeight` and `strokeAlign` (`inside`, `center` or `outside`).
- `cornerRadius` takes one number or `[topLeft, topRight, bottomRight, bottomLeft]`.
- `effects` takes an array, for example `[{"type": "dropShadow", "color": "#0000001F", "offset": [0, 4], "radius": 16}]`. Keep shadows soft and rare.
- `opacity` runs from 0 to 1.

## Batches

`batch` runs several commands as one undo step. If one step fails, nothing is changed and the error names the failing step. Anywhere in a step's params, `{"$step": n}` stands for the `id` that step `n` returned (counting from 0), so one call can build a frame and its children.

This batch builds a page frame with a hero section, a wrapping headline, a paragraph and a button:

```json canvas-batch
{
  "label": "Hero",
  "commands": [
    { "command": "node.create", "params": { "type": "frame", "name": "Landing / Toko Roti Sari", "width": 1440, "height": 900, "props": { "layout": "vertical", "sizingV": "hug", "fill": "#FBF6EE" } } },
    { "command": "node.create", "params": { "type": "frame", "name": "Hero", "parent": { "$step": 0 }, "props": { "layout": "vertical", "sizingH": "fill", "sizingV": "hug", "padding": [120, 160, 120, 160], "gap": 24, "crossAlign": "center", "fills": [] } } },
    { "command": "node.create", "params": { "type": "text", "name": "Headline", "parent": { "$step": 1 }, "text": "Roti hangat, dipanggang setiap subuh", "props": { "fontSize": 72, "fontStyle": "Bold", "lineHeight": 76, "letterSpacing": "-3%", "fill": "#2B1D14", "textAlign": "center", "sizingH": "fill", "maxWidth": 960, "textAutoResize": "height" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Subhead", "parent": { "$step": 1 }, "text": "Sourdough, croissant mentega dan roti manis dari dapur kecil kami di Kemang. Pesan sebelum jam 10, ambil sore harinya.", "props": { "fontSize": 20, "lineHeight": 30, "fill": "#6B5446", "textAlign": "center", "sizingH": "fill", "maxWidth": 680, "textAutoResize": "height" } } },
    { "command": "node.create", "params": { "type": "frame", "name": "CTA button", "parent": { "$step": 1 }, "props": { "layout": "horizontal", "sizingH": "hug", "sizingV": "hug", "padding": [16, 28, 16, 28], "cornerRadius": 8, "fill": "#A8432A" } } },
    { "command": "node.create", "params": { "type": "text", "name": "CTA label", "parent": { "$step": 4 }, "text": "Pesan lewat WhatsApp", "props": { "fontSize": 17, "fontStyle": "Semi Bold", "fill": "#FFFFFF" } } }
  ]
}
```

Pass that object as the `batch` tool's arguments. `{"$step": n, "field": "<name>"}` picks another field of step `n`'s result when you need one.

## Components

- `run_command` with `component.create` and `{"ids": [id]}` turns a frame into a component. You can also create one directly with `create_node` and `"type": "component"`.
- `instance.create` with `{"component": id, "parent": id}` places an instance inside an auto layout parent.
- `component.addProperty` with `{"id": component, "name": "Label", "type": "text", "layer": textId}` exposes a text layer, and `instance.setProperties` with `{"ids": [instance], "properties": {"Label": "Pro"}}` sets it per instance.
- `edit.duplicate` with `{"ids": [id]}` copies layers when you do not need a component.

Make a component when the same element repeats three or more times and should stay in sync, such as a pricing card, a list row or a nav item. Keep the main component outside the design frame, next to it, and use only instances inside the design. This batch makes a card component below the row and places two instances in the row:

```json canvas-batch
{
  "label": "Plan cards",
  "commands": [
    { "command": "node.create", "params": { "type": "frame", "name": "Plans", "width": 1120, "height": 400, "props": { "layout": "horizontal", "gap": 24, "sizingV": "hug", "fills": [] } } },
    { "command": "node.create", "params": { "type": "component", "name": "Plan card", "x": 0, "y": 600, "width": 340, "height": 200, "props": { "layout": "vertical", "gap": 12, "padding": 32, "sizingV": "hug", "cornerRadius": 16, "fill": "#F5F7FA" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Plan name", "parent": { "$step": 1 }, "text": "Starter", "props": { "fontSize": 20, "fontStyle": "Semi Bold", "fill": "#0F172A" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Plan price", "parent": { "$step": 1 }, "text": "Rp 49.000 / bulan", "props": { "fontSize": 32, "fontStyle": "Bold", "fill": "#0F172A" } } },
    { "command": "component.addProperty", "params": { "id": { "$step": 1 }, "name": "Name", "type": "text", "layer": { "$step": 2 } } },
    { "command": "component.addProperty", "params": { "id": { "$step": 1 }, "name": "Price", "type": "text", "layer": { "$step": 3 } } },
    { "command": "instance.create", "params": { "component": { "$step": 1 }, "parent": { "$step": 0 } } },
    { "command": "instance.create", "params": { "component": { "$step": 1 }, "parent": { "$step": 0 } } },
    { "command": "instance.setProperties", "params": { "ids": [{ "$step": 7 }], "properties": { "Name": "Pro", "Price": "Rp 99.000 / bulan" } } }
  ]
}
```

## Variables

Variables hold design tokens. A collection has modes, such as `Light` and `Dark`, and each variable has a value per mode.

- `variable.createCollection` with `{"name": "Warm Editorial", "modes": ["Light", "Dark"]}`.
- `variable.create` with `{"collection": "Warm Editorial", "name": "color/bg", "type": "color", "values": {"Light": "#FBF6EE", "Dark": "#1E1611"}}`. Types are `color`, `number`, `string` and `boolean`; `value` sets every mode at once.
- `variable.bind` with `{"ids": [id], "field": "fill", "variable": "color/bg"}`. Fields include `fill`, `stroke`, `gap`, `paddingHorizontal`, `cornerRadius`, `width`, `height`, `opacity` and `fontSize`.
- `variable.setMode` with `{"ids": [rootFrame], "collection": "Warm Editorial", "mode": "Dark"}` switches a frame and everything in it to the dark values.

`get_canvas_style` returns these commands ready to run for each style.

## Looking at your work

- `screenshot` with `{"ids": [id]}` renders those layers; with no ids it renders the whole page. Keep `maxSize` at the default unless you need detail.
- `get_node` with `{"id": id, "depth": 2}` shows sizes, sizing, layout and text settings; use it to find the layer behind a problem you see in a screenshot.
- `inspect_document` shows the current page's tree, styles and variables.
- `list_commands` with a `filter` such as `"variable"`, `"component"` or `"align"` lists every command and its parameters.
