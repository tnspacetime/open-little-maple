import type { Element, Root, RootContent } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSanitize, {
	defaultSchema,
	type Options as SanitizeSchema,
} from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { TableOfContentsItem } from "./table-of-contents";
import { xcodeDarkTheme, xcodeLightTheme } from "./xcode-code-themes";

const markdownSchema: SanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		code: [
			...(defaultSchema.attributes?.code ?? []),
			["className", /^language-./],
		],
	},
};

function collectTableOfContents(
	node: Root | RootContent,
	tableOfContents: Array<TableOfContentsItem>,
) {
	if (node.type === "element") {
		const heading = /^h([1-3])$/.exec(node.tagName);
		const id = node.properties.id;

		if (heading && typeof id === "string") {
			tableOfContents.push({
				depth: Number(heading[1]),
				id,
				title: hastToString(node as Element),
			});
		}
	}

	if ("children" in node) {
		for (const child of node.children) {
			collectTableOfContents(child, tableOfContents);
		}
	}
}

async function compileMarkdown(
	markdown: string,
	options: { tableOfContents?: boolean } = {},
) {
	const tableOfContents: Array<TableOfContentsItem> = [];
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkRehype)
		.use(rehypeSanitize, markdownSchema);

	if (options.tableOfContents) {
		processor
			.use(rehypeSlug)
			.use(() => (tree: Root) => collectTableOfContents(tree, tableOfContents));
	}

	const result = await processor
		.use(rehypePrettyCode, {
			theme: {
				light: xcodeLightTheme,
				dark: xcodeDarkTheme,
			},
			keepBackground: false,
			defaultLang: { block: "plaintext" },
			filterMetaString: (meta) =>
				meta.replace(/(^|\s)numbers(?=\s|$)/g, "$1showLineNumbers").trim(),
		})
		.use(rehypeStringify)
		.process(markdown);

	return { markup: String(result), tableOfContents };
}

/** Compiles Markdown into sanitized HTML during content generation. */
export async function renderMarkdown(markdown: string): Promise<string> {
	return (await compileMarkdown(markdown)).markup;
}

/** Compiles Markdown and returns its h1-h3 navigation outline. */
export async function renderMarkdownWithTableOfContents(markdown: string) {
	return compileMarkdown(markdown, { tableOfContents: true });
}
