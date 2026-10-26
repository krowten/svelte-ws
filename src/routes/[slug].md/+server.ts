import type { EntryGenerator, RequestHandler } from './$types';

import { error } from '@sveltejs/kit';

import { flat } from '#lib/nav.js';
import { docMarkdown } from '#lib/server/markdown.js';

export const prerender = true;

export const entries: EntryGenerator = () => flat.map(({ slug }) => ({ slug }));

/** Every docs page as plain Markdown, linked from its HTML version and from llms.txt. */
export const GET: RequestHandler = ({ params }) => {
	if (!flat.some((item) => item.slug === params.slug)) error(404);
	return new Response(docMarkdown(params.slug), {
		headers: { 'content-type': 'text/markdown; charset=utf-8' }
	});
};
