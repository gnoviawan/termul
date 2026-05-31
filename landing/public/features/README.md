# Feature demo recordings

The landing page feature section (`src/components/FeatureSection.tsx`) plays a
short screen recording in each feature frame when motion is allowed. Drop the
clips in this folder using the exact filenames below. Until a file exists the
page automatically falls back to the synthetic mockup for that feature, so it is
safe to add recordings one at a time.

## Expected files

Each feature wants up to three files: an MP4 (required), a WebM (optional,
smaller), and a JPG poster (optional, shown before the clip loads).

| Feature                  | MP4                              | WebM                              | Poster                            |
| ------------------------ | -------------------------------- | --------------------------------- | --------------------------------- |
| 01 Tabbed interface      | `01-tabbed-interface.mp4`        | `01-tabbed-interface.webm`        | `01-tabbed-interface.jpg`         |
| 02 Multiple shells       | `02-multiple-shells.mp4`         | `02-multiple-shells.webm`         | `02-multiple-shells.jpg`          |
| 03 Project workspaces    | `03-project-workspaces.mp4`      | `03-project-workspaces.webm`      | `03-project-workspaces.jpg`       |
| 04 Split panes           | `04-split-panes.mp4`             | `04-split-panes.webm`             | `04-split-panes.jpg`              |
| 05 Code & markdown editor| `05-code-markdown-editor.mp4`    | `05-code-markdown-editor.webm`    | `05-code-markdown-editor.jpg`     |
| 06 Browser annotation    | `06-browser-annotation.mp4`      | `06-browser-annotation.webm`      | `06-browser-annotation.jpg`       |
| 07 Git panel             | `07-git-panel.mp4`               | `07-git-panel.webm`               | `07-git-panel.jpg`                |
| 08 Git worktree          | `08-git-worktree.mp4`            | `08-git-worktree.webm`            | `08-git-worktree.jpg`             |
| 09 Command palette       | `09-command-palette.mp4`         | `09-command-palette.webm`         | `09-command-palette.jpg`          |

## Recording guidelines

The frame renders at a 4:3 aspect ratio and the video is `object-cover`, so
match the shape and keep the action centered.

- **Aspect / size:** record 4:3, e.g. 1280×960. Use the same window size and
  theme for every clip so the section feels consistent.
- **Length:** 6–12 seconds, no intro or outro. The clip loops, so end where it
  can cut back to the start cleanly.
- **Audio:** none. The player is muted; do not rely on sound.
- **Weight:** aim for under ~2 MB per MP4. Trim length and resolution before
  bumping compression.
- **Content:** show the one action that sells the feature (drag a tab, split a
  pane, stage + commit, open the palette). Avoid reading text on screen.

## What to capture per feature

- **01 Tabbed interface** — reorder tabs by dragging, then open a new shell.
- **02 Multiple shells** — open the shell picker, switch PowerShell → WSL, run a
  command in each.
- **03 Project workspaces** — click between two projects, each restoring its own
  terminals and directory.
- **04 Split panes** — drag a tab to a pane edge to split, then drag-resize the
  divider.
- **05 Code & markdown editor** — open a code file (highlighting), switch to a
  markdown file with live preview and an inline Mermaid diagram.
- **06 Browser annotation** — annotate an element, set severity + intent, then
  export.
- **07 Git panel** — stage a change, commit, then show the history graph.
- **08 Git worktree** — add a worktree as a sub-project and open a terminal in it.
- **09 Command palette** — open the palette, type to filter, jump to a project.

## Export commands (ffmpeg)

```bash
# MP4 (H.264), web-optimized, silent
ffmpeg -i raw.mov -an -vf "scale=1280:960:force_original_aspect_ratio=increase,crop=1280:960" \
  -c:v libx264 -crf 26 -preset slow -movflags +faststart 01-tabbed-interface.mp4

# WebM (VP9), smaller
ffmpeg -i raw.mov -an -vf "scale=1280:960:force_original_aspect_ratio=increase,crop=1280:960" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 01-tabbed-interface.webm

# Poster from the first frame
ffmpeg -i 01-tabbed-interface.mp4 -frames:v 1 -q:v 3 01-tabbed-interface.jpg
```
