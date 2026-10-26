/** Canonical origin of the deployed docs site (GitHub Pages project page). */
export const SITE_URL = 'https://krowten.github.io/svelte-ws';

/**
 * The landing page's own URL. GitHub Pages redirects the bare project path to its trailing
 * slash form, so canonical links and the sitemap point at this one directly.
 */
export const HOME_URL = `${SITE_URL}/`;

export const SITE_NAME = 'svelte-ws';

/**
 * Landing page metadata; docs pages carry theirs in `nav.ts`. The keyword leads and the
 * brand trails, matching the docs titles, and the description stays inside the ~155
 * characters a search result shows.
 */
export const SITE_TITLE = 'WebSocket remote functions for SvelteKit | svelte-ws';
export const SITE_DESCRIPTION =
	'WebSockets for SvelteKit 3. Write stream() and mutate() in *.socket.ts and serve them over one connection, in vite dev and from a Bun or Node server.';

export const REPO_URL = 'https://github.com/krowten/svelte-ws';

/** Social card shared by every page: 1200×630, the size Open Graph and X both expect. */
export const OG_IMAGE = {
	url: `${SITE_URL}/og.png`,
	width: 1200,
	height: 630,
	alt: 'svelte-ws — WebSocket remote functions for SvelteKit'
};

/** Who stands behind the docs, for structured data. */
export const AUTHOR = { '@type': 'Person', name: 'krowten', url: 'https://github.com/krowten' };
