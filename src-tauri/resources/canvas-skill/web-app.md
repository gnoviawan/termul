# Web app screens

Desktop application screens: admin panels, settings, forms, lists and tables, sign-in pages, empty states.

## Frame and shell

- One root frame per screen, 1440 × 1024 (`frame.create` with the `Desktop` preset), `layout: "horizontal"`, filled with `color/bg`.
- **Sidebar**: a vertical frame 240 to 280 wide, `sizingV: "fill"`, padding 16 to 24, filled with `surface`. The product wordmark at the top, then nav items, then the account at the bottom (`mainAlign: "spaceBetween"` on an inner frame, or a `fill` spacer).
- **Main area**: a vertical frame with `sizingH: "fill"` and `sizingV: "fill"`. Inside it, a top bar about 64 high (page title on the left, search and actions on the right), then the content with padding 32.
- Simple tools may skip the sidebar and use a top bar only.

## Content patterns

- **Page header**: the page title (`h2` step), one line of description in `muted`, and the main action button on the right of the same row.
- **Tables**: a vertical frame of rows. Each row is a horizontal frame with `sizingH: "fill"`, padding `[12, 16, 12, 16]` and a bottom stroke in `border` (`strokeSides` `[0, 0, 1, 0]`). Fix the width of narrow columns (status, amount, actions) and let the name column `fill`. Right-align numbers and use `features` `{"tnum": true}`.
- **Forms**: one column, 480 to 640 wide. Each field is a vertical frame with a label (`label` or `small` step), an input frame 44 to 48 high with a 1-unit `border` stroke and the style's small radius, and optional help text. Group related fields under a short heading; put the buttons at the end, main action first.
- **Settings**: a narrow left list of sections, or stacked groups, each group a heading, a description and its controls.
- **Status**: small pills (`hug` frames with a pill radius and a tinted fill) with one or two words. Use the same colour for the same meaning everywhere.
- **Empty states**: a short sentence that says what will appear here and one button that makes it appear.

## Sign-in pages

- Centre a single column, 400 to 440 wide, on the page: the wordmark, a heading, the fields, the main button with `sizingH: "fill"`, then a secondary link.
- Optionally split the page: the form on one half, a calm brand panel in `primary` or `surface` with one sentence on the other half.

## Density

- Body text 14 to 16 in apps, row heights 44 to 56, gaps of 8 to 16 inside a group and 24 to 32 between groups.
- Show realistic data: names, dates, amounts and statuses that fit the subject, in the user's language and currency, with some variety in length.

## Avoid

- A card around every table, form and chart on the page. The main area is already the container.
- More than one filled button in a toolbar.
- Icons drawn from many paths. A small square or circle in `muted` stands in for an icon well enough at this stage; label the action in text.
