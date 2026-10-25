# Landing pages

Marketing pages, product and company pages, portfolios, pricing pages and school or shop profiles on the web.

## Frame

- One root frame, 1440 wide, `layout: "vertical"`, `sizingV: "hug"`, `gap: 0`, filled with `color/bg`.
- Each section is a child frame with `sizingH: "fill"` and `sizingV: "hug"`. Give it horizontal padding of 120 to 160 so content sits in a column about 1120 to 1200 wide.
- Vertical padding between 96 and 160 per section. The hero gets the most.

## The story the page tells

A good page makes a claim, backs it up, and asks for one action. Order the sections to follow that:

1. **Nav**: the wordmark on the left, three to five links and one button on the right. A horizontal frame with `mainAlign: "spaceBetween"` and `crossAlign: "center"`, padding about `[24, 120, 24, 120]`.
2. **Hero (the claim)**: a headline, one supporting sentence, the main button and, if it helps, a secondary text link. Optionally an image block beside it or below it.
3. **Proof**: something the reader can believe: figures ("4.9 dari 312 ulasan"), customer names, a short quote, press or partner names as text.
4. **What you get**: three to six benefits or offerings, each a short title and one or two sentences.
5. **How it works or what is inside**: steps, a menu, a product list, a curriculum, a gallery.
6. **Offer**: prices, plans, opening hours and location, or a booking form.
7. **Final call to action**: the headline idea restated in a few words and the same main button.
8. **Footer**: contact details, address, social links as text, a copyright line. Small text in `muted`.

Leave out what the subject does not need. A bakery needs the menu, hours and location more than a feature grid; a SaaS product needs proof and pricing.

## Headlines

- Lead with what changes for the reader. A transformation ("Bangun pagi, roti sudah menunggu") is stronger than an outcome ("Sarapan lebih cepat"), which is stronger than a benefit ("Praktis"), which is stronger than a feature ("Pesan online").
- Keep it under about ten words. Use the style's `display` or `h1` step, with tight letter spacing.
- The supporting sentence says who it is for and how it works, in 15 to 30 words.

## Composition

- Pick one hero layout: centred (headline, sentence and button stacked in the middle), or split (copy on the left half, an image block on the right half, both `sizingH: "fill"` in a horizontal frame with `gap` 64).
- Feature rows: a horizontal frame with `gap` 32 to 48 whose items are vertical frames with `sizingH: "fill"`, so the columns share the width equally. Wrap them only in cards when each item is clickable.
- Alternate `bg` and `surface` section backgrounds to pace a long page, instead of adding borders and shadows.
- Use one main button style throughout. A secondary action is a text link or an outline.
- Keep paragraphs to `maxWidth` 640 to 720.

## Pricing pages

- Two to four plans in one row of equal-width columns. Mark the recommended plan with the `primary` fill or a small "Paling populer" label, not with a bigger card.
- Each plan: name, price with its period, one sentence on who it is for, four to seven included items, one button.
- Follow with a short comparison or a frequently asked questions section, then the final call to action.

## Portfolios

- The work leads. Put the first project in the hero, large, with the person's name and discipline as a small line above it.
- Show projects as big image blocks in a two-column or asymmetric grid, each with a title and one line under it.
- The about and contact sections are short; contact is an email address and a city.

## Avoid

- A hero with a gradient background, a shadowed card and three badges. Pick the one element that matters.
- Feature cards with an icon in a coloured circle, a title and a paragraph, repeated six times.
- Centred paragraphs longer than two lines.
- Stock phrases: "Unlock your potential", "Revolutionize", "Seamless", "Solusi terbaik untuk Anda".
