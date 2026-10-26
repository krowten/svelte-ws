import { nav } from '#lib/nav.js';
import { REPO_URL, SITE_DESCRIPTION, SITE_URL } from '#lib/site.js';

export const prerender = true;

/** The llmstxt.org index: what svelte-ws is, when it fits, and every page as Markdown. */
export function GET(): Response {
	const sections = nav.map(
		(group) =>
			`## ${group.title}\n\n` +
			group.items
				.map((item) => `- [${item.title}](${SITE_URL}/${item.slug}.md): ${item.description}`)
				.join('\n')
	);

	const body = `# svelte-ws

> ${SITE_DESCRIPTION}

svelte-ws brings SvelteKit's remote functions model to WebSockets: \`stream()\` and \`mutate()\`
exported from \`*.socket.ts\` files, schema-validated with Standard Schema, typed on the client
and multiplexed over one connection. It includes a pub/sub bus (in memory or on Redis), an
in-memory test client, and adapters built on SvelteKit's official \`adapter-node\` and
\`adapter-bun\`.

- Requires SvelteKit 3 and Svelte 5, and a long-running server: Bun 1.4+ or Node 22.17+.
  Serverless platforms such as Vercel or Cloudflare are not supported.
- If data only flows from the server to the browser, SvelteKit's own \`query.live\` may be
  enough; the Alternatives page compares the options.

${sections.join('\n\n')}

## Optional

- [Full documentation](${SITE_URL}/llms-full.txt): every page above in one file
- [Source code](${REPO_URL})
`;
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
