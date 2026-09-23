import { Link } from "@tanstack/react-router";
import Codicon from "./Codicon";
import ThemeToggle from "./ThemeToggle";

const navigationControl =
	"inline-flex size-9 items-center justify-center rounded-full no-underline transition hover:bg-[var(--contrast-control-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3] dark:focus-visible:outline-[#2997ff]";

const activeNavigationControl = `${navigationControl} bg-[var(--contrast-control-bg)]`;

export default function NavigationIsland() {
	return (
		<div className="pointer-events-none sticky top-0 z-50 flex justify-center px-4 pt-4">
			<div className="flex flex-col items-center gap-2">
				<nav
					aria-label="Primary navigation"
					className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-[var(--contrast-surface)] p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.1)]"
				>
					<Link
						to="/"
						aria-label="Home"
						title="Home"
						className={navigationControl}
						style={{ color: "var(--contrast-ink)" }}
						activeProps={{ className: activeNavigationControl }}
						activeOptions={{ exact: true }}
					>
						<Codicon name="home" />
					</Link>

					<Link
						to="/docs"
						aria-label="Docs"
						title="Docs"
						className={navigationControl}
						style={{ color: "var(--contrast-ink)" }}
						activeProps={{ className: activeNavigationControl }}
					>
						<Codicon name="file-text" />
					</Link>

					<ThemeToggle />
				</nav>
				<div
					id="docs-table-of-contents-slot"
					className="pointer-events-auto empty:hidden"
				/>
			</div>
		</div>
	);
}
