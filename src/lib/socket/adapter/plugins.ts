import type { Adapter, AdapterViteConfig } from '@sveltejs/kit';
import type { Plugin } from 'vite';
import type { SocketPluginOptions } from '../vite.js';

import { sveltekitSocket } from '../vite.js';

type ViteOption = Adapter['vite'];
type PluginList = NonNullable<Plugin | Plugin[] | false | null | undefined>;

const list = (plugins: unknown): PluginList[] =>
	Array.isArray(plugins) ? plugins : plugins ? [plugins as PluginList] : [];

/**
 * Add `sveltekitSocket()` to an official adapter's Vite plugins (before SvelteKit's own,
 * where it has always been documented to go), plus any `post` plugins the svelte-ws side of
 * the adapter needs. SvelteKit applies an adapter's plugins in dev and build alike, so the
 * app's Vite config only has to name the adapter.
 */
export function withSocketPlugins(
	vite: ViteOption,
	socket: SocketPluginOptions | undefined,
	post: Plugin[] = []
): ViteOption {
	const extend = (config: AdapterViteConfig | undefined): AdapterViteConfig => {
		const plugins = Array.isArray(config?.plugins) ? { pre: config.plugins } : config?.plugins;
		return {
			...config,
			plugins: {
				pre: [sveltekitSocket(socket), ...list(plugins?.pre)],
				post: [...list(plugins?.post), ...post]
			}
		} as AdapterViteConfig;
	};
	return typeof vite === 'function' ? (ctx) => extend(vite(ctx)) : extend(vite);
}
