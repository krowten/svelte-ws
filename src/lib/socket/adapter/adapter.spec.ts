import type { Adapter, AdapterViteConfig, Builder } from '@sveltejs/kit';
import type { Plugin } from 'vite';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

// adapter-node's own build is covered by the e2e suite; here it only has to be callable
const officialAdapt = vi.fn();
vi.mock('@sveltejs/adapter-node', () => ({
	default: () => ({
		name: '@sveltejs/adapter-node',
		adapt: officialAdapt,
		vite: { plugins: { post: [{ name: 'vite-plugin-sveltekit-adapter-node' }] } }
	})
}));
vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
	writeFileSync: vi.fn()
}));

const { default: nodeAdapter } = await import('./node.js');
const { default: bunAdapter } = await import('./bun.js');
const { withSocketPlugins } = await import('./plugins.js');
const { NODE_ENTRY } = await import('./node/entry.js');

const written = vi.mocked(writeFileSync);
beforeEach(() => {
	written.mockClear();
	officialAdapt.mockClear();
});

function plugins(adapter: Adapter) {
	const vite = adapter.vite as AdapterViteConfig;
	const { pre = [], post = [] } = vite.plugins as { pre?: Plugin[]; post?: Plugin[] };
	return { pre: pre.map((p) => p.name), post: post.map((p) => p.name) };
}

describe('svelte-ws adapters', () => {
	it('keep the official adapters underneath and add the socket plugin before SvelteKit', () => {
		expect(bunAdapter().name).toBe('svelte-ws/adapter-bun');
		expect(nodeAdapter().name).toBe('svelte-ws/adapter-node');

		expect(plugins(bunAdapter())).toEqual({
			pre: ['svelte-ws'],
			post: ['vite-plugin-sveltejs-adapter-bun']
		});
		expect(plugins(nodeAdapter())).toEqual({
			pre: ['svelte-ws'],
			post: ['vite-plugin-sveltekit-adapter-node', 'svelte-ws:adapter-node']
		});
	});

	it('bundles the Node WebSocket module next to adapter-node and boots it first', async () => {
		const post = (nodeAdapter().vite as AdapterViteConfig).plugins as { post: Plugin[] };
		const input = post.post.find((p) => p.name === 'svelte-ws:adapter-node')!;
		const config = (input.config as () => Record<string, never>)();
		expect(config).toMatchObject({
			environments: {
				ssr: { build: { rolldownOptions: { input: { 'svelte-ws-socket': expect.any(String) } } } }
			}
		});

		const builder = { log: { minor: vi.fn() } } as unknown as Builder;
		await nodeAdapter({ out: 'dist-server' }).adapt(builder);
		expect(officialAdapt).toHaveBeenCalledWith(builder);
		expect(written).toHaveBeenCalledWith(path.join('dist-server', 'index.js'), NODE_ENTRY);
		// import order is evaluation order: socket.config's init runs before the server listens
		expect(NODE_ENTRY.indexOf('svelte-ws-socket.js')).toBeLessThan(
			NODE_ENTRY.indexOf('adapter-index.js')
		);
	});

	it('extends an adapter whose vite config is a function of the validated config', () => {
		const vite = withSocketPlugins(() => ({ plugins: [{ name: 'upstream' }] }), undefined);
		expect(typeof vite).toBe('function');
		const resolved = (vite as (ctx: never) => AdapterViteConfig)({} as never);
		const { pre, post } = resolved.plugins as { pre: Plugin[]; post: Plugin[] };
		expect(pre.map((p) => p.name)).toEqual(['svelte-ws', 'upstream']);
		expect(post).toEqual([]);
	});
});
