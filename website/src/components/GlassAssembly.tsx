import {
	type MotionValue,
	motion,
	useReducedMotion,
	useScroll,
	useSpring,
	useTransform,
} from "motion/react";
import type { RefObject } from "react";

const GLASS_LAYER_STEP = 78;
const GLASS_LAYER_DEPTH = 58;

const layeredGlassPanes = Array.from({ length: 27 }, (_, index) => {
	const layer = Math.floor(index / 9) - 1;
	const cell = index % 9;
	const column = (cell % 3) - 1;
	const row = Math.floor(cell / 3) - 1;
	const angle = (index + 1) * 2.399963;
	const radius = 150 + (index % 6) * 20;

	return {
		id: `layered-pane-${layer}-${row}-${column}`,
		x: column * GLASS_LAYER_STEP,
		y: row * GLASS_LAYER_STEP,
		z: layer * GLASS_LAYER_DEPTH,
		scatteredX: Number(
			(column * GLASS_LAYER_STEP + Math.cos(angle) * radius).toFixed(3),
		),
		scatteredY: Number(
			(row * GLASS_LAYER_STEP + Math.sin(angle) * radius).toFixed(3),
		),
		scatteredZ: layer * GLASS_LAYER_DEPTH + (((index * 11) % 9) - 4) * 46,
		rotateX: ((index * 47) % 170) - 85,
		rotateY: ((index * 71) % 190) - 95,
		rotateZ: ((index * 29) % 130) - 65,
		opacity: 0.52 + (layer + 1) * 0.1,
	};
});

const glassPaneClassName =
	"absolute h-[72px] w-[72px] rounded-[10px] border border-black/25 bg-[linear-gradient(145deg,rgba(255,255,255,0.8),rgba(255,255,255,0.34)_48%,rgba(174,174,181,0.2))] shadow-[inset_0_1px_0_rgba(255,255,255,0.88),inset_0_0_0_1px_rgba(0,0,0,0.06)] [will-change:transform,opacity] dark:border-white/30 dark:bg-[linear-gradient(145deg,rgba(126,126,136,0.34),rgba(52,52,60,0.25)_50%,rgba(0,0,0,0.32))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_0_0_1px_rgba(255,255,255,0.06)]";

type ScrollGlassPaneProps = {
	readonly assembly: MotionValue<number>;
	readonly pane: (typeof layeredGlassPanes)[number];
};

function ScrollGlassPane({ assembly, pane }: ScrollGlassPaneProps) {
	const transform = useTransform(assembly, (progress) => {
		const scattered = 1 - progress;
		const x = pane.x + (pane.scatteredX - pane.x) * scattered;
		const y = pane.y + (pane.scatteredY - pane.y) * scattered;
		const z = pane.z + (pane.scatteredZ - pane.z) * scattered;
		const rotateX = pane.rotateX * scattered;
		const rotateY = pane.rotateY * scattered;
		const rotateZ = pane.rotateZ * scattered;
		const scale = 0.5 + progress * 0.5;

		return `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`;
	});
	const opacity = useTransform(assembly, [0, 1], [0.08, pane.opacity + 0.08]);

	return (
		<motion.div
			className={glassPaneClassName}
			style={{
				marginLeft: -36,
				marginTop: -36,
				opacity,
				transform,
			}}
		/>
	);
}

/** Assemble and disperse the glass panes with the principles section's scroll progress. */
export default function GlassAssembly({
	sectionRef,
}: {
	readonly sectionRef: RefObject<HTMLElement | null>;
}) {
	const reducedMotion = useReducedMotion();
	const { scrollYProgress } = useScroll({
		target: sectionRef,
		offset: ["start 82%", "end 18%"],
	});
	const rawAssembly = useTransform(
		scrollYProgress,
		[0, 0.18, 0.76, 1],
		[0, 1, 1, 0],
	);
	const smoothAssembly = useSpring(rawAssembly, {
		stiffness: 150,
		damping: 28,
		mass: 0.28,
	});
	const staticAssembly = useTransform(scrollYProgress, () => 1);
	const assembly = reducedMotion ? staticAssembly : smoothAssembly;
	const rawRotateY = useTransform(
		scrollYProgress,
		[0, 0.18, 0.76, 1],
		[-32, -24, 22, 30],
	);
	const rotateY = useSpring(rawRotateY, {
		stiffness: 120,
		damping: 26,
		mass: 0.32,
	});

	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-0 z-0 overflow-visible"
		>
			<div className="sticky top-0 flex h-svh items-center justify-center overflow-visible">
				<div className="relative h-[320px] w-[320px] scale-[0.8] sm:scale-100 [perspective:1000px]">
					<motion.div
						className="absolute left-1/2 top-1/2 h-0 w-0 [transform-style:preserve-3d] [will-change:transform]"
						style={{
							rotateX: -16,
							rotateY: reducedMotion ? -24 : rotateY,
							rotateZ: 0,
						}}
					>
						{layeredGlassPanes.map((pane) => (
							<ScrollGlassPane
								key={`scroll-${pane.id}`}
								assembly={assembly}
								pane={pane}
							/>
						))}
					</motion.div>
				</div>
			</div>
		</div>
	);
}
