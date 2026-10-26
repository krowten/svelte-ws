import { flat } from '#lib/nav.js';
import { docMarkdown } from '#lib/server/markdown.js';

export const prerender = true;

/** The whole documentation as one Markdown file, in sidebar order. */
export function GET(): Response {
	const body = flat.map((item) => docMarkdown(item.slug).trim()).join('\n\n---\n\n') + '\n';
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
