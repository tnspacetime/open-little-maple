import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { GITHUB_URL } from "../lib/links";
import GitHubIcon from "./GitHubIcon";

const panes = Array.from({ length: 9 }, (_, index) => {
	const column = index % 3;
	const row = Math.floor(index / 3);

	return {
		id: `pane-${row}-${column}`,
		startX: (column - 1) * 28,
		startY: (row - 1) * 28,
		startRotate: (column - row) * 8,
		delay: 0.12 + index * 0.045,
	};
});

export default function GitHubInvite() {
	const sectionRef = useRef<HTMLElement>(null);
	const inView = useInView(sectionRef, { amount: 0.3 });
	const reducedMotion = useReducedMotion();
	const revealed = reducedMotion || inView;

	return (
		<motion.section
			ref={sectionRef}
			aria-label="Little Maple GitHub repository"
			className="relative mx-auto flex min-h-[240px] w-full max-w-[680px] flex-col items-center justify-center gap-7 overflow-hidden rounded-[1.4rem] bg-white px-6 py-9 shadow-[0_18px_36px_rgba(0,0,0,0.09)] ring-1 ring-black/10 sm:min-h-[230px] sm:flex-row sm:gap-9 sm:px-12 dark:bg-black dark:shadow-[0_18px_36px_rgba(0,0,0,0.12)] dark:ring-white/10"
			initial={reducedMotion ? false : { opacity: 0, y: 20 }}
			animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
			transition={{
				duration: reducedMotion ? 0 : 0.8,
				ease: [0.16, 1, 0.3, 1],
			}}
		>
			<div
				aria-hidden="true"
				className="relative z-10 grid shrink-0 grid-cols-3 gap-1.5"
			>
				{panes.map((pane) => (
					<motion.span
						key={pane.id}
						className="size-7 rounded-[7px] border border-black/15 bg-[linear-gradient(145deg,rgba(255,255,255,0.9),rgba(240,240,245,0.7)_50%,rgba(205,205,215,0.48))] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_0_0_1px_rgba(0,0,0,0.04),0_3px_8px_rgba(0,0,0,0.06)] backdrop-blur-[10px] sm:size-9 sm:rounded-[9px] dark:border-white/25 dark:bg-[linear-gradient(145deg,rgba(126,126,136,0.34),rgba(52,52,60,0.25)_50%,rgba(0,0,0,0.32))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_0_0_1px_rgba(255,255,255,0.06)]"
						initial={false}
						animate={
							revealed
								? { opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }
								: {
										opacity: 0,
										x: pane.startX,
										y: pane.startY,
										rotate: pane.startRotate,
										scale: 0.75,
									}
						}
						transition={{
							type: "spring",
							stiffness: 140,
							damping: 19,
							mass: 0.75,
							delay: reducedMotion ? 0 : pane.delay,
						}}
					/>
				))}
			</div>

			<motion.span
				aria-hidden="true"
				className="hidden h-px min-w-10 flex-1 origin-left bg-[linear-gradient(90deg,rgba(0,0,0,0.18),rgba(0,0,0,0.04))] sm:block dark:bg-[linear-gradient(90deg,rgba(255,255,255,0.22),rgba(255,255,255,0.05))]"
				initial={reducedMotion ? false : { scaleX: 0, opacity: 0 }}
				animate={
					revealed ? { scaleX: 1, opacity: 1 } : { scaleX: 0, opacity: 0 }
				}
				transition={{ duration: reducedMotion ? 0 : 0.85, delay: 0.35 }}
			/>

			<motion.a
				href={GITHUB_URL}
				target="_blank"
				rel="noreferrer"
				style={{ color: "var(--sea-ink)" }}
				className="relative z-10 inline-flex shrink-0 items-center gap-3 rounded-full border border-black/15 bg-[linear-gradient(145deg,rgba(255,255,255,0.92),rgba(242,242,247,0.74)_50%,rgba(224,225,232,0.58))] px-5 py-3.5 text-sm font-semibold no-underline shadow-[inset_0_1px_0_rgba(255,255,255,1),inset_0_0_0_1px_rgba(255,255,255,0.65),0_10px_24px_rgba(0,0,0,0.08)] backdrop-blur-[10px] outline-none hover:border-black/30 focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-4 focus-visible:ring-offset-white dark:border-white/30 dark:bg-[linear-gradient(145deg,rgba(116,116,124,0.42),rgba(46,46,52,0.25)_50%,rgba(0,0,0,0.35))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.24),inset_0_0_0_1px_rgba(255,255,255,0.06),0_12px_34px_rgba(0,0,0,0.24)] dark:hover:border-white/50 dark:focus-visible:ring-white dark:focus-visible:ring-offset-black"
				initial={reducedMotion ? false : { opacity: 0, y: 10 }}
				animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
				whileHover={reducedMotion ? undefined : { y: -3, scale: 1.03 }}
				whileTap={reducedMotion ? undefined : { scale: 0.98 }}
				transition={{
					type: "spring",
					stiffness: 230,
					damping: 23,
					delay: reducedMotion ? 0 : 0.35,
				}}
			>
				<GitHubIcon size={19} />
				Visit the repo
			</motion.a>
		</motion.section>
	);
}
