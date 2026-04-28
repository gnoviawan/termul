import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

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
	const chartRef = useRef<HTMLDivElement>(null);
	const [svg, setSvg] = useState("");
	const [error, setError] = useState<string | null>(null);
	const isDark = useIsDark();

	// Zoom / pan state
	const [scale, setScale] = useState(1);
	const [translateX, setTranslateX] = useState(0);
	const [translateY, setTranslateY] = useState(0);
	const _isDragging = useRef(false);
	const dragStart = useRef({ x: 0, y: 0 });
	const translateStart = useRef({ x: 0, y: 0 });

	// Render mermaid
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

	// Reset zoom/pan when source changes
	useEffect(() => {
		setScale(1);
		setTranslateX(0);
		setTranslateY(0);
	}, [source]);

	const handleWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		if (!containerRef.current || !chartRef.current) return;

		const containerRect = containerRef.current.getBoundingClientRect();
		const mouseX = e.clientX - containerRect.left;
		const mouseY = e.clientY - containerRect.top;

		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
		const minScale = 0.2;
		const maxScale = 5;

		setScale((prev) => {
			const newScale = Math.min(
				Math.max(prev * zoomFactor, minScale),
				maxScale,
			);
			// Zoom toward mouse position
			const scaleRatio = newScale / prev;
			setTranslateX((tx) => tx * scaleRatio + mouseX * (1 - scaleRatio));
			setTranslateY((ty) => ty * scaleRatio + mouseY * (1 - scaleRatio));
			return newScale;
		});
	}, []);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return; // Only left click
			_isDragging.current = true;
			dragStart.current = { x: e.clientX, y: e.clientY };
			translateStart.current = {
				x: translateX,
				y: translateY,
			};
			// Prevent text selection
			e.preventDefault();
		},
		[translateX, translateY],
	);

	const handleMouseMove = useCallback((e: React.MouseEvent) => {
		if (!_isDragging.current) return;
		const dx = e.clientX - dragStart.current.x;
		const dy = e.clientY - dragStart.current.y;
		setTranslateX(translateStart.current.x + dx);
		setTranslateY(translateStart.current.y + dy);
	}, []);

	const handleMouseUp = useCallback(() => {
		_isDragging.current = false;
	}, []);

	const handleReset = useCallback(() => {
		setScale(1);
		setTranslateX(0);
		setTranslateY(0);
	}, []);

	const handleZoomIn = useCallback(() => {
		setScale((prev) => Math.min(prev * 1.2, 5));
	}, []);

	const handleZoomOut = useCallback(() => {
		setScale((prev) => Math.max(prev / 1.2, 0.2));
	}, []);

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
			className="relative w-full overflow-hidden rounded border bg-muted/30"
			style={{
				height: "400px",
				cursor: _isDragging.current ? "grabbing" : "grab",
			}}
			onWheel={handleWheel}
			onMouseDown={handleMouseDown}
			onMouseMove={handleMouseMove}
			onMouseUp={handleMouseUp}
			onMouseLeave={handleMouseUp}
		>
			{/* Chart layer */}
			<div
				ref={chartRef}
				className="inline-block origin-top-left"
				style={{
					transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
					willChange: "transform",
				}}
				dangerouslySetInnerHTML={{ __html: svg }}
			/>

			{/* Toolbar */}
			<div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-background/80 backdrop-blur border p-1 shadow-sm">
				<button
					type="button"
					className="inline-flex h-7 w-7 items-center justify-center rounded text-xs font-medium hover:bg-accent"
					onClick={handleZoomIn}
					title="Zoom In (Scroll up)"
				>
					<ZoomIn className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="inline-flex h-7 w-7 items-center justify-center rounded text-xs font-medium hover:bg-accent"
					onClick={handleZoomOut}
					title="Zoom Out (Scroll down)"
				>
					<ZoomOut className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="inline-flex h-7 w-7 items-center justify-center rounded text-xs font-medium hover:bg-accent"
					onClick={handleReset}
					title="Reset View"
				>
					<RotateCcw className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
