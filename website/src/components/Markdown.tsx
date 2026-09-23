import { useEffect, useRef } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import styles from "./Markdown.module.css";

type MarkdownProps = {
	readonly className?: string;
	readonly html: string;
};

function createIcon(kind: "copy" | "check") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "13");
	svg.setAttribute("height", "13");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", kind === "check" ? "2.1" : "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");

	if (kind === "check") {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "m20 6-11 11-5-5");
		svg.appendChild(path);
		return svg;
	}

	const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	rect.setAttribute("width", "14");
	rect.setAttribute("height", "14");
	rect.setAttribute("x", "8");
	rect.setAttribute("y", "8");
	rect.setAttribute("rx", "2");
	rect.setAttribute("ry", "2");

	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute(
		"d",
		"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
	);
	svg.append(rect, path);
	return svg;
}

export default function Markdown({ className, html }: MarkdownProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const classes = className
		? `${styles.markdown} ${className}`
		: styles.markdown;

	useEffect(() => {
		const container = containerRef.current;

		if (!container || !html) {
			return;
		}

		const figures = container.querySelectorAll<HTMLElement>(
			"[data-rehype-pretty-code-figure]",
		);
		const cleanups: Array<() => void> = [];

		for (const figure of figures) {
			const code = figure.querySelector("code");

			if (!code) {
				continue;
			}
			const codeElement: Element = code;
			const button = document.createElement("button");
			const copyIcon = createIcon("copy");
			const checkIcon = createIcon("check");
			const label = document.createElement("span");
			let resetTimer: ReturnType<typeof setTimeout> | null = null;
			let active = true;

			button.type = "button";
			button.className = styles.copyButton;
			label.setAttribute("aria-live", "polite");
			label.setAttribute("aria-atomic", "true");
			button.append(copyIcon, checkIcon, label);

			function showCopiedState(copied: boolean) {
				button.setAttribute(
					"aria-label",
					copied ? "Code copied to clipboard" : "Copy code to clipboard",
				);
				copyIcon.toggleAttribute("hidden", copied);
				checkIcon.toggleAttribute("hidden", !copied);
				label.textContent = copied ? "Copied" : "Copy";
			}

			async function handleCopy() {
				try {
					await copyTextToClipboard(codeElement.textContent ?? "");

					if (!active) {
						return;
					}

					showCopiedState(true);

					if (resetTimer) {
						clearTimeout(resetTimer);
					}

					resetTimer = setTimeout(() => showCopiedState(false), 1800);
				} catch {
					if (active) {
						showCopiedState(false);
					}
				}
			}

			showCopiedState(false);
			button.addEventListener("click", handleCopy);
			figure.appendChild(button);

			cleanups.push(() => {
				active = false;

				if (resetTimer) {
					clearTimeout(resetTimer);
				}

				button.removeEventListener("click", handleCopy);
				button.remove();
			});
		}

		return () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, [html]);

	return (
		<div
			ref={containerRef}
			className={classes}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Content Collections sanitizes this build-time HTML before it reaches the component.
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
