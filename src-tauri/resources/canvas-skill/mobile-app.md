# Mobile app screens

Phone screens and flows: onboarding, sign-in, home, lists, details, checkout, profiles.

## Frame

- One root frame per screen from a preset: `iPhone 16` (393 × 852) by default, `Android Compact` (412 × 917) when the user mentions Android.
- Root: `layout: "vertical"`, fixed size, filled with `color/bg`, `clip: true`.
- Keep the top 54 units free for the status bar and the bottom 34 for the home indicator: use top padding of about 54 and bottom padding of about 34 on the root, or empty frames of those heights.
- Several screens of a flow sit side by side with a gap of 120, in flow order, each named ("1 Onboarding", "2 Sign in").

## Layout

- Side margins of 16 to 24. Every content block uses `sizingH: "fill"` so the margins come from the root's padding.
- A scrolling body is a vertical frame with `sizingV: "fill"` between the header and the tab bar.
- **Tab bar**: a horizontal frame at the bottom, 64 to 83 high including the home indicator space, with three to five items spread with `mainAlign: "spaceEvenly"`. Each item is a small shape over a one-word label.
- **Header**: the screen title (24 to 32, `Bold`) or a small centred title with back and action buttons.

## Touch and text

- Touch targets are at least 44 × 44. Buttons are 48 to 56 high, usually `sizingH: "fill"`, with the style's medium radius or a pill.
- Body text 15 to 17; never under 13 for anything the user must read.
- One main button per screen, near the bottom where the thumb is.

## Common screens

- **Onboarding**: an image block taking the top half, a headline, one sentence, page dots, and a button.
- **Sign in**: the wordmark, a heading, two fields, the main button, a secondary link; nothing else.
- **Home**: a greeting or the screen title, one featured item, then a list or a two-column grid.
- **Detail**: an image block, the title and key facts, a description, and a fixed bottom bar with the price and the main button.
- **Checkout**: line items with prices, a summary with the total in the `h3` step, the payment choice, one button.

This batch is a sign-in screen scaffold to start from:

```json canvas-batch
{
  "label": "Sign in screen",
  "commands": [
    { "command": "frame.create", "params": { "preset": "iPhone 16", "x": 0, "y": 0, "name": "Sign in", "props": { "layout": "vertical", "padding": [96, 24, 34, 24], "gap": 16, "fill": "#FAF8FF" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Wordmark", "parent": { "$step": 0 }, "text": "Sekolahku", "props": { "fontSize": 22, "fontStyle": "Bold", "fill": "#6D4AE0" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Title", "parent": { "$step": 0 }, "text": "Masuk ke akun orang tua", "props": { "fontSize": 30, "fontStyle": "Bold", "lineHeight": 38, "fill": "#241B3A", "sizingH": "fill", "textAutoResize": "height" } } },
    { "command": "node.create", "params": { "type": "frame", "name": "Email field", "parent": { "$step": 0 }, "props": { "layout": "horizontal", "sizingH": "fill", "sizingV": "hug", "padding": [14, 16, 14, 16], "cornerRadius": 18, "fill": "#FFFFFF", "stroke": "#E0D8F7", "strokeWeight": 1 } } },
    { "command": "node.create", "params": { "type": "text", "name": "Email placeholder", "parent": { "$step": 3 }, "text": "nama@email.com", "props": { "fontSize": 16, "fill": "#5E5577" } } },
    { "command": "node.create", "params": { "type": "frame", "name": "Spacer", "parent": { "$step": 0 }, "props": { "sizingH": "fill", "sizingV": "fill", "fills": [] } } },
    { "command": "node.create", "params": { "type": "frame", "name": "Sign in button", "parent": { "$step": 0 }, "props": { "layout": "horizontal", "sizingH": "fill", "sizingV": "hug", "mainAlign": "center", "padding": [16, 24, 16, 24], "cornerRadius": 28, "fill": "#6D4AE0" } } },
    { "command": "node.create", "params": { "type": "text", "name": "Sign in label", "parent": { "$step": 6 }, "text": "Masuk", "props": { "fontSize": 17, "fontStyle": "Semi Bold", "fill": "#FFFFFF" } } }
  ]
}
```

## Avoid

- Desktop habits on a phone: multi-column layouts, small text links as the main action, hover states.
- A shadowed card around every list item. Use dividers in `border` or spacing.
- Filling the screen to the edge; keep the margins.
