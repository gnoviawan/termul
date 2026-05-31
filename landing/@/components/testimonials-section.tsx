import { cn } from "@/lib/utils";
import { InfiniteSlider } from "@/components/ui/infinite-slider";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import { ArrowUpRightIcon } from "lucide-react";

type Testimonial = {
	quote: string;
	image: string;
	name: string;
	role: string;
	company?: string;
	href: string;
};

const testimonials: Testimonial[] = [
	{
		quote:
			"Switching repos used to mean rebuilding my whole terminal layout. Termul keeps each project’s shells exactly where I left them.",
		image: "https://github.com/shadcn.png",
		name: "Alex Chen",
		role: "Staff Engineer",
		company: "Platform team",
		href: "#",
	},
	{
		quote:
			"Split panes plus a built-in browser for docs means I rarely alt-tab out of one window during deep work.",
		image: "https://github.com/rauchg.png",
		name: "Morgan Lee",
		role: "Full-stack",
		company: "Indie SaaS",
		href: "#",
	},
	{
		quote:
			"Session restore after a reboot is the feature I didn’t know I needed until I lost three terminals mid-deploy.",
		image: "https://github.com/steven-tey.png",
		name: "Jordan Kim",
		role: "DevOps",
		company: "Infra",
		href: "#",
	},
	{
		quote:
			"Project-scoped env vars land in every new shell automatically. No more copy-pasting from a stale .env.",
		image: "https://unavatar.io/x/peer_rich",
		name: "Sam Rivera",
		role: "Backend",
		company: "API squad",
		href: "#",
	},
	{
		quote:
			"The tabbed workspace feels closer to an IDE than a traditional terminal—and that’s a compliment.",
		image: "https://github.com/serafimcloud.png",
		name: "Riley Park",
		role: "Tech lead",
		company: "Mobile",
		href: "#",
	},
	{
		quote:
			"Annotations in the embedded browser saved our team hours when onboarding people to internal dashboards.",
		image: "https://unavatar.io/x/sama",
		name: "Casey Nguyen",
		role: "Product engineer",
		company: "Growth",
		href: "#",
	},
	{
		quote:
			"Cross-platform parity matters for us. Termul on macOS and Windows finally looks and behaves the same.",
		image: "https://unavatar.io/x/sundarpichai",
		name: "Drew Patel",
		role: "Engineering manager",
		company: "Distributed",
		href: "#",
	},
	{
		quote:
			"I run five services locally; named workspaces beat a folder of random iTerm profiles any day.",
		image: "https://unavatar.io/x/tim_cook",
		name: "Taylor Brooks",
		role: "SRE",
		company: "Reliability",
		href: "#",
	},
	{
		quote:
			"Lightweight Tauri app, native feel, and it doesn’t fight my GPU like some Electron terminals do.",
		image: "https://unavatar.io/x/JeffBezos",
		name: "Jamie Ortiz",
		role: "Systems",
		company: "Data",
		href: "#",
	},
	{
		quote:
			"Termul became the default launcher for every repo I touch. One place for shells, browser, and context.",
		image: "https://unavatar.io/x/elonmusk",
		name: "Quinn Walsh",
		role: "Founder",
		company: "Startup",
		href: "#",
	},
];

const firstRow = testimonials.slice(0, 5);
const secondColumn = testimonials.slice(5, 10);

export function TestimonialsSection() {
	return (
		<section className="relative mx-auto max-w-5xl">
			<div className="mx-auto mb-10 w-full max-w-2xl space-y-2 text-center">
				<h2
					id="testimonials-heading"
					className="text-3xl md:text-5xl font-medium tracking-tight mb-8 text-balance"
				>
					Built for developers who live in the terminal
				</h2>
				<p className="text-gray-400 text-lg leading-relaxed">
					Teams use Termul to keep projects, shells, and context in one
					workspace—without rebuilding their setup every time they switch repos.
				</p>
			</div>

			<div className="mask-l-from-80% mask-r-from-80% relative">
				<InfiniteSlider gap={0} speed={30} speedOnHover={0.5}>
					{firstRow.map((testimonial) => (
						<TestimonialsCard key={testimonial.name} {...testimonial} />
					))}
				</InfiniteSlider>
				<InfiniteSlider gap={0} reverse speed={30} speedOnHover={0.5}>
					{secondColumn.map((testimonial) => (
						<TestimonialsCard key={testimonial.name} {...testimonial} />
					))}
				</InfiniteSlider>
			</div>
		</section>
	);
}

function TestimonialsCard({
	className,
	quote,
	company,
	image,
	name,
	role,
	...props
}: React.ComponentProps<"a"> & Testimonial) {
	return (
		<a
			className={cn(
				"group relative flex w-full max-w-xs flex-col justify-between *:px-4 hover:cursor-pointer *:md:px-6",
				className
			)}
			{...props}
		>
			<blockquote className="flex-1 py-4">
				<p className="text-foreground text-sm">{quote}</p>
			</blockquote>
			<figcaption className="flex h-16 items-center justify-between">
				<div className="flex items-center gap-2">
					<Avatar className="size-8 rounded-full">
						<AvatarImage alt={`${name}'s profile picture`} src={image} />
						<AvatarFallback>{name.charAt(0)}</AvatarFallback>
					</Avatar>
					<div className="flex flex-col py-2">
						<cite className="font-medium text-sm not-italic leading-5">
							{name}
						</cite>
						<span className="text-muted-foreground text-xs leading-5">
							{role}
							{company && `, ${company}`}
						</span>
					</div>
				</div>
				<ArrowUpRightIcon aria-hidden="true" className={cn(
                						"size-4 opacity-0 group-hover:opacity-100",
                						"group-hover:translate-x-1 group-hover:-translate-y-1",
                						"transition-all duration-250 ease-out"
                					)} />
			</figcaption>
			{/* Hover Effect */}
			<div
				aria-hidden="true"
				className={cn(
					"absolute inset-5 -z-1 rounded-lg bg-accent opacity-0 transition-all duration-100 ease-out group-hover:inset-0 group-hover:opacity-100 dark:bg-muted/50 dark:group-active:bg-muted"
				)}
			/>
		</a>
	);
}
