---
name: termul-canvas
description: How to design on Termul Canvas so a short, vague request still ends as a polished, coherent design. Read before the first canvas edit in a session.
---

# Termul Canvas design skill

You are designing for someone who may never have briefed a designer. They type a few words, such as "landing page toko roti" or "dashboard for my gym", and expect a finished design on the first try. This skill gives you the mechanics, the defaults and the working order to deliver that.

Read topics with `read_canvas_guide({"topic": "<name>"})`. Calling it with no topic returns this index.

## Read before your first edit

| Topic | Why |
| --- | --- |
| `canvas-basics` | How frames, auto layout, sizing, text, components and variables behave on this canvas, with the traps that break layouts. |
| `working-protocol` | The build order, the check after every section, and how to fix problems. |

Also read `vague-prompts` when the request is short or names no brand, audience or content.

## Read the guide that fits the request

| Topic | Use it for |
| --- | --- |
| `landing-page` | Marketing pages, product pages, company profiles, portfolios on the web. |
| `web-app` | Desktop app screens: admin panels, settings, forms, tables, sign-in pages on the web. |
| `mobile-app` | Phone screens and flows: onboarding, sign-in, home feeds, checkout. |
| `dashboard` | Figures, charts and tables on one screen. |
| `slides` | Pitch decks, presentations, single slides. |
| `social-post` | Instagram posts and stories, posters, banners, thumbnails. |
| `design-system` | Colour and type tokens, text styles, reusable components and their variants. |

## Styles

When the user gives no brand, call `get_canvas_style()` to list the curated styles and `get_canvas_style({"name": "<style>"})` to get one. Tell the user in one short line which style you picked and why. A style's `apply` field is a ready `batch` call that creates its colour, spacing and radius variables.

## General rules

1. Put every design in its own top-level frame, named for what it is ("Landing / Toko Roti Sari"). Never draw loose layers on the page.
2. Build with auto layout from the root frame down. Set position with `layout`, `gap`, `padding`, `mainAlign` and `crossAlign`, not with `x` and `y`.
3. Give every text layer that can be longer than a few words a width it can wrap in: `sizingH: "fill"` with `textAutoResize: "height"` inside auto layout, or a fixed `width` outside it.
4. Use only the Inter family, in the faces `Regular`, `Italic`, `Semi Bold` and `Bold`. Other families and faces do not render on this canvas today. They fall back to one of these, and the result's `warnings` say so.
5. Take colours from the style's tokens or the document's variables. Do not invent a new colour for each layer.
6. Build one section per `batch` call, with named steps (`"as"` and `{"$name": ...}`, see `canvas-basics`), then look at it with `screenshot` before you build the next one. Read the `issues` and `warnings` in every result that changes the canvas and fix what they name. If a `batch` fails, nothing changes and the error names the failing step.
7. Fix a problem by changing the layers you have (`set_properties`, `node.reparent`), not by deleting them and drawing them again.
8. Name the layers you make. "Hero", "Pricing / Pro plan" and "CTA button" help the user; "Frame 12" does not.
9. Write real copy in the user's language. Never use lorem ipsum or "Your headline here".
10. Keep your thinking short and let the user see the design grow on the canvas. Progress on screen beats a long plan in chat.

## Taste rules

- **Do not put everything in a box.** Group with space, alignment and an occasional background band. Use a card only when the item is a separate, self-contained thing, such as a product, a plan or a post.
- **Use effects sparingly.** At most one shadow style and one gradient in a design, and often none. A flat, well-spaced layout looks more finished than a decorated one.
- **Keep one alignment axis per section.** Either everything in the section is centred, or everything is left-aligned. Centre only short text: headlines, a single sentence, a button.
- **Build hierarchy from size first, then weight, then colour.** One clear headline per view, with a big step down to the supporting text.
- **Keep body text readable.** Body text is at least 16 on web pages and 15 on phones, never under 14 anywhere, and lines stay between about 45 and 80 characters (`maxWidth` around 640 to 720 for 17 to 18 pixel text).
- **Space on a scale.** Use the style's spacing steps. Keep gaps inside a group smaller than the gaps between groups.
- **Keep contrast high.** Body text on its background reaches at least 4.5:1. Never put grey text on a coloured or photo-like background.
- **Do not fake a logo.** Never build a logo out of paths and shapes. Set the brand name as a wordmark in text instead.
- **Show where images go, plainly.** The canvas has no stock photos. Use a solid `surface` block with a short caption ("Photo: fresh croissants on the counter") rather than drawing a fake picture.
- **Use one accent.** It marks the single most important action or number in a view.
