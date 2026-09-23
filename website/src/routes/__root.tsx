import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import Footer from "../components/Footer";
import NavigationIsland from "../components/NavigationIsland";
import { seo } from "../lib/seo";

import appCss from "../styles.css?url";

const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(
	/\/$/,
	"",
);
const SITE_TITLE = "Little Maple | A hackable coding-agent harness";
const SITE_DESCRIPTION =
	"A pure, well-designed, hackable harness for experimenting with coding agents.";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				name: "theme-color",
				content: "#f5f5f7",
			},
			{
				name: "author",
				content: "Little Maple",
			},
			{
				name: "robots",
				content: "index, follow",
			},
			...seo({
				title: SITE_TITLE,
				description: SITE_DESCRIPTION,
				keywords:
					"Little Maple, coding agent, agent harness, LLM, TypeScript, event sourcing",
				image: "/og.png",
				url: SITE_URL,
				siteUrl: SITE_URL,
			}),
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			...(SITE_URL
				? [
						{
							rel: "canonical",
							href: SITE_URL,
						},
					]
				: []),
			{
				rel: "icon",
				href: "/favicon.svg?v=1",
				type: "image/svg+xml",
			},
			{
				rel: "icon",
				type: "image/png",
				sizes: "32x32",
				href: "/favicon-32x32.png?v=1",
			},
			{
				rel: "icon",
				type: "image/png",
				sizes: "16x16",
				href: "/favicon-16x16.png?v=1",
			},
			{
				rel: "shortcut icon",
				href: "/favicon.ico?v=1",
			},
			{
				rel: "apple-touch-icon",
				sizes: "180x180",
				href: "/apple-touch-icon.png?v=1",
			},
			{
				rel: "manifest",
				href: "/site.webmanifest",
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Static theme initializer with no user-controlled input. */}
				<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
				<HeadContent />
			</head>
			<body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-[rgba(41,151,255,0.22)]">
				<NavigationIsland />
				{children}
				<Footer />
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
