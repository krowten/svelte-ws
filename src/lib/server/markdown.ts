import { readFileSync } from 'node:fs';

import { SITE_URL } from '#lib/site.js';
import { docSource } from './lastmod.js';

/**
 * A docs page as raw Markdown for LLM readers (`/<slug>.md`, `llms-full.txt`). Site links
 * are root-relative in the source, so they become absolute: the reader has no base URL.
 */
export function docMarkdown(slug: string): string {
	return readFileSync(docSource(slug), 'utf8').replaceAll('](/', `](${SITE_URL}/`);
}
