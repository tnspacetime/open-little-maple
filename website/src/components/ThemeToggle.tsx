import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import Codicon from "./Codicon";

type ThemeMode = "light" | "dark";

function getInitialMode(): ThemeMode {
	const stored = window.localStorage.getItem("theme");

	if (stored === "light" || stored === "dark") {
		return stored;
	}

	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyThemeMode(mode: ThemeMode) {
	document.documentElement.classList.remove("light", "dark");
	document.documentElement.classList.add(mode);
	document.documentElement.setAttribute("data-theme", mode);
	document.documentElement.style.colorScheme = mode;
}

const spring = {
	type: "spring",
	stiffness: 430,
	damping: 34,
	mass: 0.78,
} as const;

const contentVariants = {
	initial: (direction: number) => ({
		opacity: 0,
		y: direction * 7,
		filter: "blur(2px)",
	}),
	animate: {
		opacity: 1,
		y: 0,
		filter: "blur(0px)",
	},
	exit: (direction: number) => ({
		opacity: 0,
		y: direction * -7,
		filter: "blur(2px)",
	}),
};

export default function ThemeToggle() {
	const [mode, setMode] = useState<ThemeMode>("light");
	const reducedMotion = useReducedMotion();
	const isInitialSync = useRef(true);
	const isDark = mode === "dark";
	const direction = isDark ? 1 : -1;

	useEffect(() => {
		const initialMode = getInitialMode();
		setMode(initialMode);
		applyThemeMode(initialMode);

		const frame = window.requestAnimationFrame(() => {
			isInitialSync.current = false;
		});

		return () => window.cancelAnimationFrame(frame);
	}, []);

	function toggleTheme() {
		const nextMode = isDark ? "light" : "dark";
		isInitialSync.current = false;
		setMode(nextMode);
		applyThemeMode(nextMode);
		window.localStorage.setItem("theme", nextMode);
	}

	const contentTransition =
		reducedMotion || isInitialSync.current
			? { duration: 0 }
			: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

	return (
		<motion.button
			type="button"
			role="switch"
			aria-checked={isDark}
			aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
			title={`Switch to ${isDark ? "Light" : "Dark"}`}
			className="relative isolate inline-flex size-9 cursor-pointer items-center justify-center overflow-hidden rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3] dark:focus-visible:outline-[#2997ff]"
			animate={{
				color: isDark ? "#f5f5f7" : "#1d1d1f",
			}}
			whileHover={reducedMotion ? undefined : { scale: 1.018 }}
			whileTap={reducedMotion ? undefined : { scale: 0.975 }}
			transition={spring}
			onClick={toggleTheme}
		>
			<AnimatePresence initial={false} mode="wait" custom={direction}>
				<motion.span
					key={mode}
					className="relative z-10 flex items-center justify-center"
					custom={direction}
					variants={contentVariants}
					initial="initial"
					animate="animate"
					exit="exit"
					transition={contentTransition}
				>
					<Codicon name="color-mode" />
				</motion.span>
			</AnimatePresence>
		</motion.button>
	);
}
