import type { Adapter } from '@sveltejs/kit';
import type { SocketPluginOptions } from '../vite.js';

import upstream from './bun/upstream/index.js';
import { withSocketPlugins } from './plugins.js';

export type AdapterOptions = {
	/** The directory to build the server to. @default 'build' */
	out?: string;
	/** Generate `.br` and `.gz` variants of client and prerendered assets. @default false */
	precompress?: boolean;
	/** Prefix for every deployment environment variable, e.g. `MY_APP_` for `MY_APP_PORT`. */
	envPrefix?: string;
	/**
	 * JSON-serializable defaults for `Bun.serve` (`hostname`, `port`, `unix`, `reusePort`,
	 * `ipv6Only`, `idleTimeout`, `maxRequestBodySize`, `development`). Environment variables
	 * take precedence.
	 */
	serverOptions?: Record<string, unknown>;
	/** `Bun.build` options for compiling the server into a single executable (`compile`). */
	buildOptions?: Record<string, unknown>;
	/** Options for the `sveltekitSocket()` Vite plugin this adapter adds. */
	socket?: SocketPluginOptions;
};

/**
 * SvelteKit adapter for a standalone **Bun** server with a WebSocket endpoint: the official
 * `@sveltejs/adapter-bun`, forked only to hand `Bun.serve` a `websocket` handler (see
 * `bun/UPSTREAM.md`). Build with `bun --bun vite build`, run with `bun ./build`.
 *
 * ```ts
 * import adapter from 'svelte-ws/adapter-bun';
 * sveltekit({ adapter: adapter() });
 * ```
 */
export default function adapter(options: AdapterOptions = {}): Adapter {
	const { socket, ...rest } = options;
	const base = upstream(rest as Parameters<typeof upstream>[0]);
	return {
		...base,
		name: 'svelte-ws/adapter-bun',
		vite: withSocketPlugins(base.vite, socket)
	};
}
