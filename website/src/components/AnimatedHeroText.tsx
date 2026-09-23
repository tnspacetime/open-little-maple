import { motion, useReducedMotion } from "motion/react";

const enterEase = [0.16, 1, 0.3, 1] as const;

function LittleMapleMark() {
	const tiles = [1, 11.75, 22.5] as const;

	return (
		<svg
			className="size-[0.82em] shrink-0 text-[var(--sea-ink)]"
			viewBox="0 0 32 32"
			fill="currentColor"
			aria-hidden="true"
		>
			{tiles.flatMap((y) =>
				tiles.map((x) => (
					<rect
						key={`${x}-${y}`}
						x={x}
						y={y}
						width="8.5"
						height="8.5"
						rx="2.2"
					/>
				)),
			)}
		</svg>
	);
}

export default function AnimatedHeroText() {
	const reducedMotion = useReducedMotion();

	return (
		<motion.div
			className="flex flex-col items-center"
			initial={
				reducedMotion ? false : { opacity: 0, y: 20, filter: "blur(8px)" }
			}
			animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
			transition={{ duration: reducedMotion ? 0 : 0.9, ease: enterEase }}
		>
			<h1 className="m-0 inline-flex items-center justify-center gap-[0.2em] text-[clamp(2.5rem,4vw,3.25rem)] leading-[0.96] font-semibold tracking-[-0.055em]">
				<LittleMapleMark />
				<motion.span
					className="-mx-[0.08em] block bg-[linear-gradient(105deg,var(--sea-ink)_0%,var(--sea-ink)_38%,color-mix(in_srgb,var(--sea-ink)_65%,var(--bg-base))_45%,color-mix(in_srgb,var(--sea-ink)_25%,var(--bg-base))_50%,color-mix(in_srgb,var(--sea-ink)_65%,var(--bg-base))_55%,var(--sea-ink)_62%,var(--sea-ink)_100%)] bg-[length:300%_100%] bg-clip-text px-[0.08em] text-transparent"
					initial={{ backgroundPosition: "100% 50%" }}
					animate={{
						backgroundPosition: reducedMotion
							? "100% 50%"
							: ["100% 50%", "100% 50%", "0% 50%", "0% 50%"],
					}}
					transition={
						reducedMotion
							? { duration: 0 }
							: {
									duration: 6,
									times: [0, 0.2, 0.55, 1],
									ease: "easeInOut",
									repeat: Number.POSITIVE_INFINITY,
									delay: 1,
								}
					}
				>
					Little Maple
				</motion.span>
			</h1>

			<p className="mt-4 mb-0 max-w-2xl text-balance text-base leading-[1.25] font-semibold tracking-[-0.02em] text-[var(--sea-ink)] sm:mt-5 sm:text-lg">
				A pure, well-designed, hackable harness for experimenting with coding
				agents.
			</p>
		</motion.div>
	);
}
