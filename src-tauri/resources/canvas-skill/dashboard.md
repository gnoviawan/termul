# Dashboards

Screens whose job is to show numbers: business overviews, analytics, monitoring, reports.

## Frame

- One root frame, 1440 × 1024 (`Desktop` preset), using the `web-app` shell: a sidebar 240 to 280 wide and a main area with `sizingH: "fill"`.
- The main area is a vertical frame with padding 32 and `gap` 24: a header row, a row of key figures, then charts and tables.

## Decide what matters first

Before you draw, write down the three to five numbers the owner checks every day. For a gym: active members, check-ins today, revenue this month, classes at capacity. Those become the key figures; everything else supports them.

## Key figures

- A horizontal frame of three to five equal tiles (`sizingH: "fill"` each).
- Each tile: a label in `small` and `muted`, the value large (32 to 44, `Bold`, `features` `{"tnum": true}`), and a change line ("+12% dari bulan lalu") in `accent` or a semantic colour.
- Tiles may sit on `surface` with the style's medium radius. Do not add shadows.

```json canvas-batch
{
  "label": "Key figures",
  "commands": [
    { "command": "node.create", "as": "key-figures", "params": { "type": "frame", "name": "Key figures", "width": 1104, "height": 160, "props": { "layout": "horizontal", "gap": 24, "sizingV": "hug", "fills": [] } } },
    { "command": "node.create", "as": "members-tile", "params": { "type": "frame", "name": "Members tile", "parent": { "$name": "key-figures" }, "props": { "layout": "vertical", "gap": 8, "padding": 24, "sizingH": "fill", "sizingV": "hug", "cornerRadius": 10, "fill": "#141B2D" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Label", "parent": { "$name": "members-tile" }, "text": "Anggota aktif", "props": { "fontSize": 14, "fill": "#9AA6BC" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Value", "parent": { "$name": "members-tile" }, "text": "1.284", "props": { "fontSize": 40, "fontStyle": "Bold", "fill": "#E8ECF4", "features": { "tnum": true } } } },
    { "command": "node.create", "params": { "type": "text", "name": "Change", "parent": { "$name": "members-tile" }, "text": "+8,2% dari bulan lalu", "props": { "fontSize": 14, "fontStyle": "Semi Bold", "fill": "#38BDD8" } } },
    { "command": "edit.duplicate", "params": { "ids": [{ "$name": "members-tile" }] } },
    { "command": "edit.duplicate", "params": { "ids": [{ "$name": "members-tile" }] } }
  ]
}
```

Duplicates land in the same auto layout row; change their text with `set_properties` and `characters` afterwards.

## Charts

The canvas has no chart command. Draw charts from simple shapes, which is enough for a design:

- **Bar chart**: a horizontal frame with `crossAlign: "max"` and a `gap` of 8 to 16, holding rectangles of fixed width whose heights are the values scaled to the chart height. Put the axis labels in a second row of text below.
- **Line chart**: one `vector` over a few thin horizontal grid lines in `border`, with `fills: []`, `stroke` in `primary` and `strokeWeight` 2 to 3. Pass the line as `path` next to `type`, in the `create_node` arguments or the `node.create` params. `path` is not a prop, and inside `props` it is an error:

  ```json
  { "command": "node.create", "params": { "type": "vector", "name": "Line", "parent": { "$step": 0 }, "path": "M0 120 L80 96 L160 104 L240 60 L320 72 L400 28", "props": { "fills": [], "stroke": "#38BDD8", "strokeWeight": 2 } } }
  ```
- **Progress or share**: a track rectangle in `surface` with a shorter one in `primary` on top.
- Give every chart a title, the period ("30 hari terakhir") and units. Use one colour for the main series and `muted` for comparison.

## Tables

- Follow the table pattern in `web-app`: rows with a bottom stroke, fixed narrow columns, right-aligned figures with tabular numbers.
- Show 5 to 8 rows of realistic data, then a "Lihat semua" link.

## Layout

- Arrange charts on a grid of two or three columns using horizontal frames with `sizingH: "fill"` children. Make the most important chart the widest.
- Keep labels short and numbers formatted for the locale (1.284 and Rp 45,2 jt in Indonesian; 1,284 and $45.2k in English).

## Avoid

- Decorative gradients and glowing charts. The numbers are the design.
- Twelve tiles of equal weight. If everything is a key figure, nothing is.
- Pie charts with more than four slices.
