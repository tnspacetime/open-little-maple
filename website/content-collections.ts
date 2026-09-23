import { defineCollection, defineConfig } from "@content-collections/core";
import { z } from "zod";
import { renderMarkdownWithTableOfContents } from "./src/lib/markdown";

const pageSchema = z.object({
	title: z.string(),
	description: z.string(),
	content: z.string(),
});

const pages = defineCollection({
	name: "pages",
	directory: "./content",
	include: "*.md",
	schema: pageSchema,
	transform: async ({ content, ...page }) => {
		const rendered = await renderMarkdownWithTableOfContents(content);

		return {
			...page,
			slug: page._meta.path,
			...rendered,
		};
	},
});

export default defineConfig({ content: [pages] });
