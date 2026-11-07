# Canvas eval rubric

Each result is one prompt from `prompts.json`, run in a fresh agent session on an empty canvas, with or without the design harness (the `read_canvas_guide` and `get_canvas_style` tools and the instruction to use them). Score every result on the items below.

| Item | How it is scored | 1 | 5 |
| --- | --- | --- | --- |
| Layout integrity | Automatic, from `checks.ts`: 5 minus the number of issues, at least 1. Issues are collapsed frames or text, clipped text, invisible text, fonts the canvas does not render, placeholder copy, and an empty canvas. | Five or more issues | No issues |
| Visual hierarchy | Judge | No clear entry point; everything has the same weight | One obvious focal point and a clear reading order |
| Typography | Judge | Sizes and weights look random; text runs off or wraps badly | A consistent scale, readable body text, good line lengths and wrapping |
| Colour and contrast | Judge | Clashing colours, or text that is hard to read | A restrained palette with readable contrast everywhere |
| Copy | Judge | Placeholder or generic copy, or the wrong language | Specific, plausible copy in the prompt's language |
| AI-slop signals | Judge, scored inversely | Cards around everything, gradients and shadows everywhere, fake logos | None of these |
| Effort | Recorded, not scored: the number of tool calls and agent turns | | |

The median of the six scored items is the result's score. A harness is better when the median score over the prompt set rises clearly, layout-integrity failures drop to zero, and the effort does not grow out of proportion.

## Judge prompt

`run.ts judge` sends this text to the judge model, with `{prompt}` and `{image}` filled in, for each image in a blind order. The judge does not know which mode made the image.

```text
You are judging a design made by an AI agent from this request: "{prompt}".
The person who asked is not a designer and gave no other details.
Read the image file {image} and look at it carefully.

Score it from 1 (poor) to 5 (excellent) on each item:
- hierarchy: one clear focal point and reading order
- typography: consistent type scale, readable sizes, good wrapping and line length
- color: restrained palette and readable contrast
- copy: specific, plausible text in the language of the request (Indonesian requests need Indonesian copy)
- slop: 5 means no generic AI-design signals; 1 means cards around everything, gratuitous gradients or shadows, fake logos, or lorem ipsum

Answer with one JSON object and nothing else, for example:
{"hierarchy": 3, "typography": 4, "color": 4, "copy": 2, "slop": 3, "notes": "one short sentence"}
```

## Spot check

A person looks at every image with its scores before a result is reported, and corrects any score the judge clearly got wrong. Record corrections in `judge/overrides.json` as `{"<blind id>": {"<item>": <score>}}`; `run.ts report` applies them.
