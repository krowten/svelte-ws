/** One per directory under `src/routes/(docs)/`, so `resolve()` can type-check every link. */
export type DocSlug =
	| 'introduction'
	| 'remote-functions'
	| 'getting-started'
	| 'streams'
	| 'pubsub'
	| 'testing'
	| 'recipes'
	| 'compare'
	| 'server-config'
	| 'adapter'
	| 'redis'
	| 'deployment';

export type NavItem = {
	title: string;
	slug: DocSlug;
	/** `<title>` for the page; falls back to `title`. Written for search results, not the sidebar. */
	headTitle?: string;
	/** Meta description, ~150 characters. */
	description: string;
};
export type NavGroup = { title: string; items: NavItem[] };

/** Sidebar structure — also drives prev/next links, page titles and meta descriptions. */
export const nav: NavGroup[] = [
	{
		title: 'Guide',
		items: [
			{
				title: 'What is svelte-ws?',
				slug: 'introduction',
				headTitle: 'SvelteKit WebSockets with remote functions',
				description:
					"svelte-ws brings SvelteKit's remote functions model to WebSockets. Write stream() and mutate() in *.socket.ts and run them on SvelteKit 3."
			},
			{
				title: 'Remote functions',
				slug: 'remote-functions',
				headTitle: 'SvelteKit remote functions over WebSocket',
				description:
					'How SvelteKit remote functions map to WebSockets: query.live and stream(), command and mutate(), a shared pub/sub bus, and what changes in SvelteKit 3.'
			},
			{
				title: 'Getting started',
				slug: 'getting-started',
				headTitle: 'How to add WebSockets to SvelteKit',
				description:
					'Add WebSockets to a SvelteKit app with one command, npx sv add svelte-ws, or by hand: an adapter in vite.config.ts and stream() in a *.socket.ts file.'
			},
			{
				title: 'Streams & mutations',
				slug: 'streams',
				headTitle: 'WebSocket streams: reconnect and resume',
				description:
					'stream() runs an async generator over the WebSocket; mutate() handles one-shot writes. The client reconnects itself, and cursors resume a dropped stream.'
			},
			{
				title: 'The pub/sub bus',
				slug: 'pubsub',
				headTitle: 'WebSocket pub/sub for SvelteKit',
				description:
					'A pub/sub bus that socket handlers, remote functions and +server.ts all share. It runs in memory by default and on Redis once you have more instances.'
			},
			{
				title: 'Testing',
				slug: 'testing',
				headTitle: 'Testing WebSocket handlers with Vitest',
				description:
					'Test WebSocket handlers with Vitest without starting a server. createTestClient runs your *.socket.ts modules over an in-memory socket, hooks included.'
			},
			{
				title: 'Recipes',
				slug: 'recipes',
				headTitle: 'SvelteKit WebSocket recipes: auth, presence',
				description:
					'Patterns for realtime SvelteKit apps: WebSocket authentication with cookies, presence, typing indicators, optimistic updates and rate limits.'
			},
			{
				title: 'Alternatives',
				slug: 'compare',
				headTitle: 'SvelteKit realtime: WebSocket, SSE, Socket.IO',
				description:
					'Compare WebSocket, SSE (query.live), Socket.IO, svelte-realtime and hand-rolled ws for SvelteKit: when to pick each, and what SvelteKit supports natively.'
			}
		]
	},
	{
		title: 'Server',
		items: [
			{
				title: 'socket.config.ts',
				slug: 'server-config',
				headTitle: 'WebSocket auth and limits: socket.config.ts',
				description:
					'Reference for socket.config.ts, where you authenticate the WebSocket upgrade with cookies, type per-connection data and set Origin checks and limits.'
			},
			{
				title: 'Adapters',
				slug: 'adapter',
				headTitle: 'SvelteKit Bun and Node adapters with WebSockets',
				description:
					"Two SvelteKit adapters that build a standalone WebSocket server, on Bun's native API or on node:http with ws. They also replace svelte-adapter-bun."
			},
			{
				title: 'Redis pub/sub',
				slug: 'redis',
				headTitle: 'Scale WebSockets with Redis pub/sub',
				description:
					"Run SvelteKit WebSockets on several instances with Redis pub/sub. The page gives a small engine for Bun's Redis client or ioredis on Node, and its limits."
			},
			{
				title: 'Deployment',
				slug: 'deployment',
				headTitle: 'Deploy SvelteKit WebSockets: nginx, Docker',
				description:
					'How to run a SvelteKit WebSocket server behind nginx, in Docker or under systemd, with the Upgrade headers, the public origin and graceful shutdown.'
			}
		]
	}
];

export const flat: NavItem[] = nav.flatMap((group) => group.items);

/**
 * Where a route sits in the docs. Takes the route id rather than the URL pathname: the id is
 * the same during prerendering and in the browser, whereas a pathname carries the deploy base
 * path (and `resolve('/')` turns into `./` under `paths.relative` while prerendering).
 */
export function findByRoute(routeId: string | null): {
	current: NavItem | undefined;
	prev: NavItem | undefined;
	next: NavItem | undefined;
} {
	const slug = routeId?.replace(/^\/\(docs\)\//, '');
	const index = flat.findIndex((item) => item.slug === slug);
	return {
		current: flat[index],
		prev: index > 0 ? flat[index - 1] : undefined,
		next: index >= 0 && index < flat.length - 1 ? flat[index + 1] : undefined
	};
}
