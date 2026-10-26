import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import path from 'node:path';
import { sveltekitSocket } from './vite.js';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, 'test-fixtures/root');

/**
 * The plugin's `transform`/`load` hooks are plain functions — drive them with a minimal
 * rollup-ish context (`parse`, `error`, `warn`) instead of booting a Vite server.
 */
function pluginContext() {
	const warnings: string[] = [];
	const ctx = {
		parse: parseAst,
		warn: (msg: string) => warnings.push(msg),
		error: (msg: string) => {
			throw new Error(String(msg));
		},
		environment: { name: 'ssr', config: { build: { ssr: true } } }
	};
	return { ctx, warnings };
}

// vite plugin hooks may be `{ handler }` objects; ours are plain functions
type HookFn = (this: unknown, ...args: unknown[]) => unknown;
function hook(plugin: Record<string, unknown>, name: string): HookFn {
	const value = plugin[name];
	return (typeof value === 'function' ? value : (value as { handler: HookFn }).handler) as HookFn;
}

const plugin = sveltekitSocket() as unknown as Record<string, unknown>;
hook(plugin, 'configResolved').call({}, { root: FIXTURE_ROOT });

describe('sveltekitSocket transform', () => {
	// inside the fixture root, so module ids come out root-relative
	const file = `${FIXTURE_ROOT}/src/chat.socket.ts`;
	const code = [
		`import { stream, mutate } from '#lib/socket';`,
		`export const messages = stream(schema, handler);`,
		`export const send = mutate(schema, handler);`,
		`const internal = stream(handler);`, // not exported — must not leak
		``
	].join('\n');

	it('replaces a socket module with client stubs', () => {
		const { ctx } = pluginContext();
		const result = hook(plugin, 'transform').call(ctx, code, file) as { code: string };
		expect(result.code).toContain(`createStream("src/chat.socket.ts", "messages")`);
		expect(result.code).toContain(`createMutate("src/chat.socket.ts", "send")`);
		expect(result.code).not.toContain('internal');
		expect(result.code).not.toContain('schema'); // no server code leaks
	});

	it('recognises definers imported from the published package specifier', () => {
		const { ctx } = pluginContext();
		const published = [
			`import { stream, mutate } from 'svelte-ws';`,
			`export const feed = stream(schema, handler);`,
			`export const post = mutate(handler);`,
			``
		].join('\n');
		const result = hook(plugin, 'transform').call(ctx, published, file) as { code: string };
		expect(result.code).toContain(`createStream("src/chat.socket.ts", "feed")`);
		expect(result.code).toContain(`createMutate("src/chat.socket.ts", "post")`);
	});

	it('respects import aliasing of the definers', () => {
		const { ctx } = pluginContext();
		const aliased = [
			`import { stream as live, mutate as write } from '#lib/socket/index.js';`,
			`export const feed = live(handler);`,
			`export const post = write(handler);`,
			``
		].join('\n');
		const result = hook(plugin, 'transform').call(ctx, aliased, file) as { code: string };
		expect(result.code).toContain(`createStream("src/chat.socket.ts", "feed")`);
		expect(result.code).toContain(`createMutate("src/chat.socket.ts", "post")`);
	});

	it('leaves the ?socket-server variant untouched (server build)', () => {
		const { ctx } = pluginContext();
		const transform = hook(plugin, 'transform');
		expect(transform.call(ctx, code, file + '?socket-server', { ssr: true })).toBeNull();
	});

	it("keeps the real module in Vitest's server environment, for svelte-ws/testing", () => {
		const { ctx } = pluginContext();
		// VITEST is set while this very test runs
		expect(hook(plugin, 'transform').call(ctx, code, file, { ssr: true })).toBeNull();
	});

	it('serves the browser stubs even when it asks for ?socket-server', () => {
		const { ctx } = pluginContext();
		const result = hook(plugin, 'transform').call(ctx, code, file + '?socket-server') as {
			code: string;
		};
		expect(result.code).toContain('createStream');
	});

	it('ignores non-socket files', () => {
		const { ctx } = pluginContext();
		expect(hook(plugin, 'transform').call(ctx, code, '/proj/src/routes/x/+page.ts')).toBeNull();
	});

	it('warns and exports nothing for a socket file without definers', () => {
		const { ctx, warnings } = pluginContext();
		const result = hook(plugin, 'transform').call(ctx, `export const x = 1;\n`, file) as
			string | { code?: string };
		const emitted = typeof result === 'string' ? result : result?.code;
		expect(emitted).toBe('export {};\n');
		expect(warnings.length).toBe(1);
	});
});

describe('sveltekitSocket virtual modules', () => {
	it('resolves and loads the manifest', () => {
		const { ctx } = pluginContext();
		hook(plugin, 'configResolved').call(ctx, { root: FIXTURE_ROOT });
		const resolved = hook(plugin, 'resolveId').call(ctx, 'virtual:svelte-ws/manifest');
		expect(resolved).toBe('\0virtual:svelte-ws/manifest');
		const codeResult = hook(plugin, 'load').call(ctx, resolved) as string;
		// this repo has a demo socket module — it must be in the manifest with a loader
		expect(codeResult).toContain('export const modules =');
		expect(codeResult).toContain('src/chat.socket.ts');
		expect(codeResult).toContain('?socket-server');
	});

	it('loads the socket entry with websocket handler, config and endpoint', () => {
		const { ctx } = pluginContext();
		// configResolved fixes root + config file discovery (the fixture has socket.config.ts)
		hook(plugin, 'configResolved').call(ctx, { root: FIXTURE_ROOT });
		const entry = hook(plugin, 'load').call(ctx, 'virtual:svelte-ws/entry') as string;
		expect(entry).toContain('createWebSocketHandler');
		expect(entry).toContain('socket.config.ts');
		expect(entry).toContain('export const createWebSocket');
		expect(entry).toContain('ENDPOINT_PATH');
		// the Node adapter drives the same handler through this bridge
		expect(entry).toContain('attachNodeWebSocket');
	});

	it('imports the runtime with the extension it ships with', () => {
		const { ctx } = pluginContext();
		hook(plugin, 'configResolved').call(ctx, { root: FIXTURE_ROOT });
		const entry = hook(plugin, 'load').call(ctx, 'virtual:svelte-ws/entry') as string;
		// `.ts` from source in this repo, `.js` from dist in a published install — never a
		// mix, which would break consumers installing the package
		const specifiers = [...entry.matchAll(/from "([^"]+socket[^"]*)"/g)].map((m) => m[1]);
		const runtime = specifiers.filter((s) => s.startsWith('/'));
		expect(runtime.length).toBeGreaterThan(0);
		expect(runtime.every((s) => s.endsWith('.ts'))).toBe(true);
	});
});

describe('sveltekitSocket when listed twice', () => {
	// the adapters add the plugin themselves, so an app that still lists it gets two copies
	it('only lets the first copy in the resolved plugin list do anything', () => {
		const first = sveltekitSocket() as unknown as Record<string, unknown>;
		const second = sveltekitSocket() as unknown as Record<string, unknown>;
		const config = { root: FIXTURE_ROOT, plugins: [first, second] };
		hook(first, 'configResolved').call({}, config);
		hook(second, 'configResolved').call({}, config);

		const { ctx } = pluginContext();
		const file = `${FIXTURE_ROOT}/src/chat.socket.ts`;
		const code = `import { stream } from 'svelte-ws';\nexport const feed = stream(handler);\n`;
		expect(hook(first, 'transform').call(ctx, code, file)).toBeTruthy();
		expect(hook(second, 'transform').call(ctx, code, file)).toBeUndefined();
		expect(hook(second, 'resolveId').call(ctx, 'virtual:svelte-ws/entry')).toBeUndefined();
	});
});
