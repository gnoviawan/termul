# Social posts

Instagram posts and stories, posters, banners, flyers and thumbnails.

## Sizes

| Format | Preset | Size |
| --- | --- | --- |
| Instagram feed (default) | `Instagram post` | 1080 × 1350 |
| Square post | none; set `width` and `height` | 1080 × 1080 |
| Instagram or WhatsApp story | `Instagram story` | 1080 × 1920 |
| LinkedIn post | `LinkedIn post` | 1200 × 1200 |
| Facebook or link banner | `Facebook post` | 1200 × 630 |
| YouTube thumbnail | `YouTube thumbnail` | 1280 × 720 |
| Printed poster | `A4` | 595 × 842 |

When the user asks for "a post" with no format, make the 1080 × 1350 feed post. Offer the story size as a next step.

## One message

A post is seen for about a second while the reader scrolls. Give it one message and one action:

1. **The hook**: the biggest text, three to seven words ("Beli 1 gratis 1", "Kelas baru: HIIT pagi").
2. **The detail**: the offer, the date, the price; the second biggest thing.
3. **The action**: where to go or what to do ("Pesan via WhatsApp 0812-3456-7890", "Mulai 1 November").
4. **The brand**: the name as a small wordmark in a corner.

## Composition

- Safe margins of at least 64 on every side, and 120 at the top and bottom of stories, where the app draws its own controls.
- Set the hook huge: 96 to 160 on a 1080-wide post, `Bold`, tight line height and letter spacing.
- Use flat colour shapes for energy: a big circle, a stripe, a block of the `accent` colour behind the price. Place them with `absolute: true` inside the auto layout root, or build the post without auto layout and place layers with `x` and `y`.
- A product picture is an image block in `surface` with a short caption until the user adds the photo.
- Use at most three colours from the style, plus white or black for text.

## Promotions

- Show the price or discount as a number, large, and the old price small with `textDecoration` set to strikethrough, if there is one.
- Put the deadline or date in a pill or band so it reads as urgent.

## Avoid

- More than about 25 words on a post.
- Small text near the edges.
- Drop shadows behind text. If text is hard to read, change the background or the colour.
