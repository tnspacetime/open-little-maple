import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TableOfContentsItem } from "../lib/table-of-contents";
import {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerHeader,
	DrawerTitle,
	DrawerTrigger,
} from "./ui/drawer";

type DocsTableOfContentsProps = {
	entries: Array<TableOfContentsItem>;
};

function entryClasses(depth: number) {
	if (depth <= 1) {
		return "pl-4 pr-3 text-[0.96rem] font-semibold";
	}

	if (depth === 2) {
		return "pl-8 pr-3 text-[0.92rem] font-medium";
	}

	return "pl-12 pr-3 text-sm font-medium";
}

export default function DocsTableOfContents({
	entries,
}: DocsTableOfContentsProps) {
	const [open, setOpen] = useState(false);
	const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
	const [activeId, setActiveId] = useState(entries[0]?.id ?? "");
	const navigatingToRef = useRef<string | null>(null);
	const activeEntry = useMemo(
		() => entries.find((entry) => entry.id === activeId) ?? entries[0],
		[activeId, entries],
	);

	useEffect(() => {
		setHeaderSlot(document.getElementById("docs-table-of-contents-slot"));
	}, []);

	useEffect(() => {
		if (entries.length === 0) {
			return;
		}

		const hashId = decodeURIComponent(window.location.hash.slice(1));

		if (entries.some((entry) => entry.id === hashId)) {
			setActiveId(hashId);
		}

		const headings = entries
			.map((entry) => document.getElementById(entry.id))
			.filter((heading): heading is HTMLElement => heading !== null);

		const observer = new IntersectionObserver(
			(observations) => {
				const visibleHeading = observations
					.filter((observation) => observation.isIntersecting)
					.sort(
						(a, b) =>
							Math.abs(a.boundingClientRect.top) -
							Math.abs(b.boundingClientRect.top),
					)[0];

				if (visibleHeading?.target.id) {
					setActiveId(visibleHeading.target.id);
				}
			},
			{
				rootMargin: "-132px 0px -62% 0px",
				threshold: [0, 1],
			},
		);

		for (const heading of headings) {
			observer.observe(heading);
		}

		return () => observer.disconnect();
	}, [entries]);

	if (entries.length === 0) {
		return null;
	}

	function navigateToHeading(
		event: React.MouseEvent<HTMLAnchorElement>,
		entry: TableOfContentsItem,
	) {
		event.preventDefault();
		navigatingToRef.current = entry.id;
		setActiveId(entry.id);
		setOpen(false);

		window.setTimeout(() => {
			const heading = document.getElementById(entry.id);

			if (!heading) {
				return;
			}

			window.history.pushState(null, "", `#${entry.id}`);
			heading.scrollIntoView({
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
					? "auto"
					: "smooth",
				block: "start",
			});
			navigatingToRef.current = null;
		}, 0);
	}

	const trigger = (
		<DrawerTrigger asChild>
			<button
				type="button"
				className="flex h-10 max-w-[min(30rem,calc(100vw-2rem))] cursor-pointer items-center rounded-full border border-[var(--line)] bg-[var(--contrast-surface)] px-4 text-xs leading-none font-semibold tracking-[-0.01em] text-[var(--contrast-ink)] shadow-[0_8px_24px_rgba(0,0,0,0.1)] outline-none transition hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] active:translate-y-0"
			>
				<span className="shrink-0 text-[var(--contrast-ink-soft)]">
					Contents
				</span>
				<span
					aria-hidden="true"
					className="mx-2.5 h-4 w-px shrink-0 bg-[var(--line)]"
				/>
				<span className="truncate">{activeEntry?.title}</span>
			</button>
		</DrawerTrigger>
	);

	return (
		<Drawer open={open} onOpenChange={setOpen} direction="bottom">
			{headerSlot ? createPortal(trigger, headerSlot) : null}

			<DrawerContent
				className="mx-auto max-h-[min(82dvh,46rem)] w-[calc(100%-1rem)] max-w-2xl overflow-hidden rounded-t-[1.75rem] border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_-20px_70px_rgba(0,0,0,0.18)]"
				onCloseAutoFocus={(event) => {
					if (navigatingToRef.current) {
						event.preventDefault();
					}
				}}
			>
				<DrawerHeader className="flex-row items-start justify-between gap-4 px-5 pt-4 pb-3 text-left sm:px-7">
					<div>
						<DrawerTitle className="text-lg tracking-[-0.025em] text-[var(--sea-ink)]">
							Documentation
						</DrawerTitle>
						<DrawerDescription className="mt-1 text-sm text-[var(--sea-ink-soft)]">
							Jump to any section.
						</DrawerDescription>
					</div>
					<DrawerClose asChild>
						<button
							type="button"
							className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--surface)] px-4 text-xs font-semibold text-[var(--sea-ink)] outline-none transition hover:bg-[var(--link-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
						>
							Done
						</button>
					</DrawerClose>
				</DrawerHeader>

				<nav
					aria-label="Documentation sections"
					className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-5"
				>
					<ul className="m-0 list-none space-y-1 p-0">
						{entries.map((entry) => {
							const active = entry.id === activeId;

							return (
								<li key={entry.id}>
									<a
										href={`#${entry.id}`}
										aria-current={active ? "location" : undefined}
										onClick={(event) => navigateToHeading(event, entry)}
										className={`relative flex min-h-11 items-center rounded-xl py-2.5 text-[var(--sea-ink)] no-underline outline-none transition hover:bg-[var(--link-bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${entryClasses(entry.depth)} ${
											active ? "bg-[var(--surface)]" : ""
										}`}
									>
										{active ? (
											<span
												aria-hidden="true"
												className="absolute left-1.5 size-1.5 rounded-full bg-[var(--link)]"
											/>
										) : null}
										<span>{entry.title}</span>
									</a>
								</li>
							);
						})}
					</ul>
				</nav>
			</DrawerContent>
		</Drawer>
	);
}
