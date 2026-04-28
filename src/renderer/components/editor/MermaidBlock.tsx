import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

function useIsDark(): boolean {
	const [isDark, setIsDark] = useState(
		document.documentElement.classList.contains("dark"),
	);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDark(document.documentElement.classList.contains("dark"));
		});

		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => observer.disconnect();
	}, []);

	return isDark;
}

interface MermaidBlockProps {
	source: string;
}

export function MermaidBlock({ source }: MermaidBlockProps): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const [svg, setSvg] = useState("");
	const [error, setError] = useState<string | null>(null);
	const isDark = useIsDark();

	useEffect(() => {
		if (!source.trim()) {
			setSvg("");
			setError(null);
			return;
		}

		mermaid.initialize({
			startOnLoad: false,
			theme: isDark ? "dark" : "default",
			securityLevel: "strict",
		});

		const id = `mb-${Math.random().toString(36).slice(2, 11)}`;

		mermaid
			.render(id, source)
			.then(({ svg: svgStr }) => {
				setSvg(svgStr);
				setError(null);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setSvg("");
			});
	}, [source, isDark]);

	if (error) {
		return (
			<div className="p-4 border rounded border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800">
				<p className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">
					Mermaid syntax error
				</p>
				<pre className="overflow-auto text-xs text-red-700 dark:text-red-300">
					<code>{source}</code>
				</pre>
			</div>
		);
	}

	if (!svg) {
		return (
			<div className="p-4 text-sm rounded border border-dashed border-muted-foreground/30 text-muted-foreground">
				Empty Mermaid diagram
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="mermaid-chart flex justify-center py-2"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
