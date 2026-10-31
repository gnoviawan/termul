# Slides

Pitch decks, presentations and single slides.

## Frames

- One root frame per slide from the `Slide 16:9` preset (1920 × 1080), named in order ("01 Masalah", "02 Solusi").
- Place slides in a row, left to right, with a gap of 120, all on the same `y`.
- Each slide: `layout: "vertical"`, fixed size, padding 120 to 160, filled with `color/bg`. Use `mainAlign: "center"` for statement slides and `min` for content slides.

## Type

- Slide titles 64 to 96, `Bold` or `Semi Bold`, tight letter spacing. Statement slides go up to 120 or more.
- Body text at least 28, ideally 32 to 40. If it does not fit at 28, the slide has too much on it; split it.
- One idea per slide. A title that states the point ("Pelanggan menunggu 25 menit untuk kopi") is better than a topic label ("Masalah").

## A five-slide pitch

When the user asks for a pitch deck with no outline, use this one:

1. **Title**: the company name as a wordmark, one line that says what it does, the presenter and date in small text.
2. **Problem**: the pain in one sentence, with one striking number set large.
3. **Solution**: what the product does, as three short points or one simple diagram drawn from frames and arrows.
4. **Market and traction**: two or three big figures (market size, users, revenue growth), each with a short label.
5. **The ask**: how much, what it pays for, and how to get in touch.

For more slides, add business model, competition, team and roadmap in that order.

## Composition

- Keep a consistent grid: the same padding and title position on every content slide.
- Big numbers and short phrases beat paragraphs. Use the `accent` colour for the one number that matters on each slide.
- Use a full-bleed `primary` background for the title and the closing slide only.
- A simple chart (see `dashboard`) or a three-column row is enough for data slides.

This batch makes a title slide:

```json canvas-batch
{
  "label": "Title slide",
  "commands": [
    { "command": "frame.create", "as": "slide", "params": { "preset": "Slide 16:9", "x": 0, "y": 0, "name": "01 Judul", "props": { "layout": "vertical", "mainAlign": "center", "padding": 160, "gap": 32, "fill": "#070B18" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Wordmark", "parent": { "$ref": "slide" }, "text": "Antrikopi", "props": { "fontSize": 32, "fontStyle": "Bold", "fill": "#22D3EE" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Title", "parent": { "$ref": "slide" }, "text": "Pesan kopi sebelum sampai, ambil tanpa antre", "props": { "fontSize": 104, "fontStyle": "Semi Bold", "lineHeight": 108, "letterSpacing": "-4%", "fill": "#E6E9F5", "sizingH": "fill", "maxWidth": 1400, "textAutoResize": "height" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Presenter", "parent": { "$ref": "slide" }, "text": "Pitch seed round · Oktober 2026", "props": { "fontSize": 28, "fill": "#9097B3" } } }
  ]
}
```

## Avoid

- Bullet lists of six or more items.
- A different layout on every slide.
- Decorative shapes that compete with the one idea on the slide.
