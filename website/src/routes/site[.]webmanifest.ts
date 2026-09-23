import { createFileRoute } from "@tanstack/react-router";

const manifest = {
	name: "Little Maple",
	short_name: "Little Maple",
	description:
		"A pure, well-designed, hackable harness for experimenting with coding agents.",
	start_url: "/",
	icons: [
		{
			src: "/android-chrome-192x192.png",
			sizes: "192x192",
			type: "image/png",
		},
		{
			src: "/android-chrome-512x512.png",
			sizes: "512x512",
			type: "image/png",
		},
	],
	theme_color: "#f5f5f7",
	background_color: "#f5f5f7",
	display: "standalone",
};

export const Route = createFileRoute("/site.webmanifest")({
	server: {
		handlers: {
			GET: () =>
				new Response(JSON.stringify(manifest, null, 2), {
					headers: {
						"Content-Type": "application/manifest+json",
						"Cache-Control": "public, max-age=3600",
					},
				}),
		},
	},
});
