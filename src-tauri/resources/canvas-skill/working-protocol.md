# Working protocol

The order to build in, the check to run after every section, and how to repair what the check finds. Follow it for every design, small or large.

## 1. Orient (one call)

- Call `inspect_document` with `depth` 1. Note the frames already on the page and where free space starts.
- If the user refers to an existing design ("make the header bigger"), find it here and edit it. Do not start a new frame.

## 2. Decide the brief (no tool call)

Settle these in your head before you draw, and tell the user in one or two lines:

- **What it is**: the artifact type and its size (see the domain guide).
- **Who it is for**: the audience, and the one thing they should do or feel.
- **How it looks**: the style you picked with `get_canvas_style`, or the brand the user gave.
- **What it says**: the sections in order, each with its purpose.

For a thin prompt, read `vague-prompts` first.

## 3. Set up tokens (one call)

- Run the chosen style's `apply` batch, so its colours, spacing and radii exist as variables.
- If the document already has a variable collection for this design, reuse it. A second `apply` of the same style fails without changing anything, because the collection already exists.
- Keep the style's type scale at hand. You will type its sizes, faces, line heights and letter spacing into each text layer.

## 4. Build the root frame (one call)

- Create one top-level frame for the design, named for what it is, to the right of existing frames.
- Give it the artifact's width, `layout: "vertical"`, `sizingV: "hug"` and the background colour, bound to `color/bg` with `variable.bind`.
- For several screens or slides, create one root frame each, side by side with a gap of 120, and build them one at a time.

## 5. Build one section per call

- Make each section a child frame with `sizingH: "fill"`, `sizingV: "hug"`, its own `layout`, `padding` and `gap`, and `"fills": []` unless it has its own background.
- Build the whole section, from the frame down to its last text layer, in one `batch`. Give each frame that other layers go into a name with `"as"`, and point its children at it with `{"$name": "..."}`.
- Keep the `names` map from the result. It gives the id of every named layer, so you can check and fix the section without searching for ids.
- Write the final copy now. Do not leave placeholder text to replace later.

## 6. Check the section, then fix it

After every section, call `screenshot` with the section's id and compare it with this checklist. Call `get_node` on anything that looks wrong to find the cause.

- [ ] Nothing has collapsed: no frame is 0 wide or 0 high, and no text layer is 0 wide.
- [ ] Nothing is cut off: every text layer fits inside its parent, and no line runs past the edge.
- [ ] Every text layer is visible: it has a fill, and it contrasts with what is behind it.
- [ ] Long text wraps: paragraphs use `sizingH: "fill"` or a fixed width, with `textAutoResize: "height"`.
- [ ] Alignment is consistent: one axis per section, and left edges line up.
- [ ] Spacing follows the scale: gaps inside groups are smaller than gaps between groups.
- [ ] Hierarchy reads at a glance: one dominant headline, then a clear step down.
- [ ] No leftovers: no default grey (`#D9D9D9`) rectangles, no white boxes from default frame fills, no "Frame 12" names.
- [ ] The copy is real, specific and in the user's language.

Fix what fails before you start the next section:

- Change the layers you have with `set_properties` on their ids. Do not delete a section and draw it again; that loses names, bindings and the user's trust in what they saw.
- Move a layer into another parent with `run_command` and `node.reparent`.
- If a `batch` fails, nothing changed. The error names the failing step by its index and its `as` name. Correct that step and send the batch again.
- If a whole step went wrong, `undo` it once and redo it properly.
- If the same problem comes back after two fixes, stop and read the relevant part of `canvas-basics` again; the cause is usually sizing.

## 7. Finish

- Call `screenshot` on the root frame and check the whole design against the checklist once more, at a glance this time: does it look like one design?
- Call `save_file`.
- Reply in a few lines: what you made, the style you used, and one or two things the user could ask for next. Do not describe every layer.

## Pace

- Keep your reasoning brief. The user watches the canvas; a section that appears quickly says more than a plan in chat.
- Ask at most one question, and only when the result would be useless without the answer. Otherwise make a sensible choice, say what you chose, and build.
