import { createFileRoute } from "@tanstack/react-router";
import DocsTableOfContents from "../components/DocsTableOfContents";
import Markdown from "../components/Markdown";
import { requirePage } from "../lib/pages";

export const Route = createFileRoute("/docs")({
	loader: () => requirePage("docs"),
	component: Docs,
});

function Docs() {
	const page = Route.useLoaderData();

	return (
		<>
			<DocsTableOfContents entries={page.tableOfContents} />
			<main className="page-wrap px-4 py-12 sm:py-20">
				<article className="mx-auto max-w-3xl">
					<h1 className="display-title m-0 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
						{page.title}
					</h1>
					<Markdown className="mt-8" html={page.markup} />
				</article>
			</main>
		</>
	);
}
