import { createReactBlockSpec } from "@blocknote/react";
import { defaultProps } from "@blocknote/core";
import { MermaidBlock } from "./MermaidBlock";

export const mermaidBlockSpec = createReactBlockSpec(
	{
		type: "mermaid",
		propSchema: {
			...defaultProps,
			source: {
				default: "",
			},
		},
		content: "none",
	},
	{
		render: ({ block }) => {
			return <MermaidBlock source={block.props.source} />;
		},
		toExternalHTML: ({ block }) => {
			return (
				<pre>
					<code className="language-mermaid" data-language="mermaid">
						{block.props.source}
					</code>
				</pre>
			);
		},
		parse: (e) => {
			if (e.tagName !== "PRE") {
				return undefined;
			}

			if (
				e.childElementCount !== 1 ||
				e.firstElementChild?.tagName !== "CODE"
			) {
				return undefined;
			}

			const code = e.firstElementChild!;
			const language =
				code.getAttribute("data-language") ||
				code.className
					.split(" ")
					.find((name) => name.includes("language-"))
					?.replace("language-", "");

			if (language !== "mermaid") {
				return undefined;
			}

			return { source: code.textContent || "" };
		},
	},
);
