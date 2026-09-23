import { allPages, type Page } from "content-collections";

export function requirePage(slug: string): Page {
	const page = allPages.find((candidate) => candidate.slug === slug);

	if (!page) {
		throw new Error(`Missing Markdown page: ${slug}`);
	}

	return page;
}
