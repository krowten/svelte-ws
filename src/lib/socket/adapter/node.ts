import type { Adapter } from '@sveltejs/kit';
import type { Plugin } from 'vite';
import type { SocketPluginOptions } from '../vite.js';

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import official from '@sveltejs/adapter-node';
import { NODE_ENTRY } from './node/entry.js';
import { withSocketPlugins } from './plugins.js';

type OfficialOptions = NonNullable<Parameters<typeof official>[0]>;

export type AdapterOptions = OfficialOptions & {
	/** Options for the `sveltekitSocket()` Vite plugin this adapter adds. */
	socket?: SocketPluginOptions;
};

// `.ts` in the repository, `.js` in the published package
const here = fileURLToPath(import.meta.url);
const socketModule = path.join(path.dirname(here), 'node', `socket${path.extname(here)}`);

/** Bundles the WebSocket module into the server build, next to adapter-node's runtime. */
const socketInput: Plugin = {
	name: 'svelte-ws:adapter-node',
	apply: 'build',
	config: () => ({
		environments: {
			ssr: { build: { rolldownOptions: { input: { 'svelte-ws-socket': socketModule } } } }
		}
	})
};

/**
 * SvelteKit adapter for a standalone **Node** server with a WebSocket endpoint: the official
 * `@sveltejs/adapter-node`, unchanged, plus a WebSocket upgrade handler on the HTTP server it
 * exports. Its options, environment variables and behaviour are adapter-node's. Run the
 * output with `node build`.
 *
 * ```ts
 * import adapter from 'svelte-ws/adapter-node';
 * sveltekit({ adapter: adapter() });
 * ```
 */
export default function adapter(options: AdapterOptions = {}): Adapter {
	const { socket, ...rest } = options;
	const base = official(rest);
	const out = rest.out ?? 'build';

	return {
		...base,
		name: 'svelte-ws/adapter-node',
		async adapt(builder) {
			await base.adapt(builder);
			builder.log.minor('Adding the WebSocket endpoint');
			writeFileSync(path.join(out, 'index.js'), NODE_ENTRY);
		},
		vite: withSocketPlugins(base.vite, socket, [socketInput])
	};
}
