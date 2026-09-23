import { GITHUB_URL } from "../lib/links";
import GitHubIcon from "./GitHubIcon";

const socialLinkClassName =
	"inline-flex size-9 items-center justify-center rounded-full text-[var(--contrast-ink)] no-underline transition hover:bg-[var(--contrast-control-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3] dark:focus-visible:outline-[#2997ff]";

function XIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
		</svg>
	);
}

export default function Footer() {
	const year = new Date().getFullYear();

	return (
		<footer className="mt-20 border-t border-[var(--line)] px-4 pb-14 pt-10 text-[var(--sea-ink-soft)]">
			<div className="page-wrap flex flex-col items-center justify-between gap-5 text-center sm:flex-row sm:text-left">
				<p className="m-0 text-sm">
					&copy; {year} Little Maple. Released under the MIT License.
				</p>

				<div className="inline-flex items-center gap-1 rounded-full bg-[var(--contrast-surface)] p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.1)]">
					<a
						href="https://x.com/__tuan____"
						target="_blank"
						rel="noreferrer"
						aria-label="Little Maple on X"
						title="X"
						className={socialLinkClassName}
						style={{ color: "var(--contrast-ink)" }}
					>
						<XIcon />
					</a>
					<a
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
						aria-label="Little Maple on GitHub"
						title="GitHub"
						className={socialLinkClassName}
						style={{ color: "var(--contrast-ink)" }}
					>
						<GitHubIcon />
					</a>
				</div>
			</div>
		</footer>
	);
}
