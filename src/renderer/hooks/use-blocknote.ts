import { useRef, useEffect, useMemo, useCallback } from "react";
import {
	BlockNoteEditor,
	BlockNoteSchema,
	defaultBlockSpecs,
	createCodeBlockSpec,
} from "@blocknote/core";
import { codeBlockOptions } from "@blocknote/code-block";
import { mermaidBlockSpec } from "@/components/editor/mermaid-block-spec";
import type { TocHeading } from "@/hooks/use-toc-headings";

function convertMermaidBlocks(
	blocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return blocks.map((block) => {
		if (
			block.type === "codeBlock" &&
			(block.props as Record<string, string> | undefined)?.language ===
				"mermaid"
		) {
			const source = Array.isArray(block.content)
				? block.content
						.map((c: Record<string, unknown>) => {
							if (c.type === "text") return String(c.text ?? "");
							if (c.type === "hardBreak") return "\n";
							return "";
						})
						.join("")
				: "";
			return {
				...block,
				type: "mermaid",
				props: { source },
				content: undefined,
			};
		}
		if (Array.isArray(block.children) && block.children.length > 0) {
			return {
				...block,
				children: convertMermaidBlocks(
					block.children as Array<Record<string, unknown>>,
				),
			};
		}
		return block;
	});
}

interface UseBlockNoteOptions {
	initialMarkdown: string;
	onChange: (markdown: string) => void;
}

interface UseBlockNoteResult {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	editor: BlockNoteEditor<any, any, any>;
	replaceContent: (markdown: string) => void;
	getHeadings: () => TocHeading[];
	scrollToBlock: (blockId: string) => void;
}

export function useBlockNote(options: UseBlockNoteOptions): UseBlockNoteResult {
	const onChangeRef = useRef(options.onChange);
	const initialMarkdownRef = useRef(options.initialMarkdown);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Guard to suppress onChange during programmatic replaceBlocks calls
	const isReplacingRef = useRef(false);
	// Incrementing token to discard stale replace results
	const replaceTokenRef = useRef(0);

	onChangeRef.current = options.onChange;

	const editor = useMemo(() => {
		const schema = BlockNoteSchema.create({
			blockSpecs: {
				...defaultBlockSpecs,
				codeBlock: createCodeBlockSpec(codeBlockOptions),
				mermaid: mermaidBlockSpec(),
			},
		});
		return BlockNoteEditor.create({ schema });
	}, []);

	const runReplace = useCallback(
		async (markdown: string, token: number): Promise<void> => {
			try {
				isReplacingRef.current = true;
				const blocks = await editor.tryParseMarkdownToBlocks(markdown);
				if (token !== replaceTokenRef.current) return;
				const processedBlocks = convertMermaidBlocks(
					blocks as Array<Record<string, unknown>>,
				);
				if (token !== replaceTokenRef.current) return;
				editor.replaceBlocks(editor.document, processedBlocks);
			} catch {
				// Failed to parse markdown
			} finally {
				if (token === replaceTokenRef.current) {
					requestAnimationFrame(() => {
						isReplacingRef.current = false;
					});
				}
			}
		},
		[editor],
	);

	// Load initial markdown content
	useEffect(() => {
		const token = ++replaceTokenRef.current;
		void runReplace(initialMarkdownRef.current, token);
	}, [editor, runReplace]);

	// Set up change listener
	useEffect(() => {
		const unsubscribe = editor.onChange(async () => {
			// Skip onChange events triggered by programmatic content replacement
			if (isReplacingRef.current) return;

			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
			debounceTimerRef.current = setTimeout(async () => {
				if (isReplacingRef.current) return;
				try {
					const markdown = await editor.blocksToMarkdownLossy(editor.document);
					onChangeRef.current(markdown);
				} catch {
					// Failed to convert to markdown
				}
			}, 300);
		});

		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
			if (typeof unsubscribe === "function") {
				unsubscribe();
			}
		};
	}, [editor]);

	const replaceContent = useCallback(
		async (markdown: string) => {
			const token = ++replaceTokenRef.current;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
			await runReplace(markdown, token);
		},
		[runReplace],
	);

	const getHeadings = useCallback((): TocHeading[] => {
		return editor.document.flatMap((block) => {
			if (block.type !== "heading") {
				return [];
			}

			const level =
				typeof block.props.level === "number" ? block.props.level : 1;
			const text = block.content
				.flatMap((inlineContent) => {
					if (inlineContent.type === "text") {
						return [inlineContent.text];
					}

					return [];
				})
				.join("")
				.trim();

			if (!text) {
				return [];
			}

			return [
				{
					id: block.id,
					blockId: block.id,
					level,
					text,
				},
			];
		});
	}, [editor]);

	const scrollToBlock = useCallback(
		(blockId: string): void => {
			const targetElement = editor.domElement?.querySelector<HTMLElement>(
				`[data-node-type="blockContainer"][data-id="${CSS.escape(blockId)}"]`,
			);

			if (!targetElement) {
				return;
			}

			try {
				editor.setTextCursorPosition(blockId, "start");
				editor.focus();

				requestAnimationFrame(() => {
					try {
						targetElement.scrollIntoView({
							block: "start",
							behavior: "smooth",
						});
					} catch {
						console.error("Failed to scroll TOC heading into view");
					}
				});
			} catch {
				console.error("Failed to focus TOC heading block");
			}
		},
		[editor],
	);

	return { editor, replaceContent, getHeadings, scrollToBlock };
}
