import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useRef } from "react";
import GlassAssembly from "./GlassAssembly";

const termClassName =
	"rounded-md bg-[color-mix(in_srgb,var(--sea-ink)_7%,transparent)] px-[0.3em] py-[0.08em] font-mono text-[0.86em] font-semibold tracking-[-0.02em]";

const principles = [
	{
		title: "Pure.",
		description: (
			<>
				We started with a simple foundation: an{" "}
				<code className={termClassName}>LLM</code> does its best work when the
				world around it stays coherent. So every{" "}
				<code className={termClassName}>Turn</code> begins with a complete
				picture. Its <code className={termClassName}>Provider</code>,{" "}
				<code className={termClassName}>Tools</code>,{" "}
				<code className={termClassName}>Location</code>, and{" "}
				<code className={termClassName}>ToolCallRules</code> are frozen into one
				contract—and stay that way until the work is done.
			</>
		),
	},
	{
		title: "Well-designed.",
		description:
			"The core agent loop is protected. Every provider invocation is its own step. There is no separate logical step layered over the actual invocation. Retries and recovery are explicit. Branching, plugins, and permissions are powerful, first-class primitives.",
	},
	{
		title: "Hackable.",
		description:
			"We are building Little Maple as a ground for experimentation: small enough to understand and extensible without compromising its core. Written in pure TypeScript and built on robust event-sourcing ideas.",
	},
] as const;

type PrincipleProps = {
	readonly children: ReactNode;
	readonly order: number;
	readonly title: string;
};

function Principle({ children, order, title }: PrincipleProps) {
	const reducedMotion = useReducedMotion();

	return (
		<motion.article
			className="flex flex-col items-start gap-5 py-12 sm:gap-6 sm:py-20"
			initial={
				reducedMotion ? false : { opacity: 0, y: 24, filter: "blur(8px)" }
			}
			whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
			viewport={{ once: true, amount: 0.35 }}
			transition={{
				duration: reducedMotion ? 0 : 0.8,
				delay: reducedMotion ? 0 : order * 0.04,
				ease: [0.16, 1, 0.3, 1],
			}}
		>
			<h2 className="m-0 text-[clamp(2.5rem,5vw,4.5rem)] leading-[0.94] font-semibold tracking-[-0.055em] text-[var(--sea-ink)]">
				{title}
			</h2>

			<p className="m-0 max-w-2xl text-base leading-[1.5] font-semibold tracking-[-0.02em] text-[var(--sea-ink)] sm:text-lg">
				{children}
			</p>
		</motion.article>
	);
}

export default function Principles() {
	const sectionRef = useRef<HTMLElement>(null);

	return (
		<section
			ref={sectionRef}
			className="relative mx-auto mt-16 w-full max-w-4xl pb-[28vh] sm:mt-24"
			aria-label="Little Maple design principles"
		>
			<GlassAssembly sectionRef={sectionRef} />

			<div className="relative z-10 mx-auto max-w-3xl">
				{principles.map((principle, index) => (
					<Principle
						key={principle.title}
						title={principle.title}
						order={index}
					>
						{principle.description}
					</Principle>
				))}
			</div>
		</section>
	);
}
