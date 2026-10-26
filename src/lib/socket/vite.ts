import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { ENDPOINT_PATH } from './protocol.js';
import { resolveHooks, type InitCleanup, type SocketServerHooks } from './config.js';
import { attachNodeWebSocket } from './server/node-ws.js';
import { createWebSocketHandler } from './server/ws-handler.js';
import { createResolver, type ModuleExports } from './server/registry.js';
import { configureDefaultPubSub } from './pubsub.js';

// set by Vitest: its server-side tests import socket modules for their handlers, not stubs
const { VITEST } = process.env;

const MANIFEST_ID = 'virtual:svelte-ws/manifest';
const ENTRY_ID = 'virtual:svelte-ws/entry';
const RESOLVED_MANIFEST = '\0' + MANIFEST_ID;
// The entry the adapters' WebSocket modules import statically (bundled into the server build).
const SERVER_QUERY = 'socket-server';

const SOCKET_RE = /\.socket\.(ts|js)$/;
/**
 * Import sources that provide the `stream` / `mutate` definers: the published package
 * (`svelte-ws`), or an in-repo/aliased path ending in `socket` (`#lib/socket/index.js`,
 * `../socket/index.js`) — the stand's layout and external test fixtures.
 */
const DEFINER_SOURCE_RE = /^svelte-ws$|(^|\/)socket(\/index(\.js)?)?$/;
const CLIENT_RUNTIME = 'svelte-ws/client';
const PLUGIN_NAME = 'svelte-ws';

/** This directory, as an absolute fs path — lets generated code import our runtime. */
// (`fileURLToPath`, not `.pathname`: that leaves `%20` in a path with spaces, and a leading
// slash before a Windows drive letter)
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Extension of the runtime files next to this module: `.ts` in the repo, `.js` in dist. */
const RUNTIME_EXT = path.extname(fileURLToPath(import.meta.url));

type Kind = 'stream' | 'mutate';

export type SocketPluginOptions = {
	/**
	 * Path to the server config file (relative to the project root). Its default export is a
	 * {@link import('./config.js').SocketServerConfig}. Defaults to `socket.config.ts` /
	 * `socket.config.js` if present.
	 */
	config?: string;
	/**
	 * Import specifier the generated client stubs use for the client runtime. Defaults to
	 * the package export `svelte-ws/client`; point it at an absolute path when consuming the
	 * library from source (e.g. the verification stand).
	 */
	runtime?: string;
};

function splitId(id: string): [file: string, query: string] {
	const i = id.indexOf('?');
	return i === -1 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

function isSocketFile(file: string): boolean {
	return SOCKET_RE.test(file) && !file.includes('/node_modules/');
}

function toModuleId(absFile: string, root: string): string {
	return path.relative(root, absFile).split(path.sep).join('/');
}

/** Recursively find every `*.socket.{ts,js}` under `src`. */
function collectSocketFiles(root: string): string[] {
	const srcDir = path.join(root, 'src');
	let entries: string[];
	try {
		entries = readdirSync(srcDir, { recursive: true }) as string[];
	} catch {
		return [];
	}
	return entries.filter((rel) => SOCKET_RE.test(rel)).map((rel) => path.join(srcDir, rel));
}

function findConfigFile(root: string, explicit?: string): string | null {
	if (explicit) {
		const abs = path.resolve(root, explicit);
		if (!existsSync(abs)) {
			throw new Error(`[svelte-ws] config file not found: ${explicit}`);
		}
		return abs;
	}
	for (const name of ['socket.config.ts', 'socket.config.js']) {
		const abs = path.join(root, name);
		if (existsSync(abs)) return abs;
	}
	return null;
}

/**
 * Classify each `export const NAME = stream|mutate(...)` in already-compiled module JS.
 * Returns the kind per export so we can emit the right client stub. Returns `null` if the
 * module can't be parsed (caller surfaces an error rather than leaking server code).
 */
function classifyExports(
	this: { parse: (code: string) => unknown },
	code: string
): Record<string, Kind> | null {
	// the parser returns an untyped ESTree program; we walk it structurally
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let ast: any;
	try {
		ast = this.parse(code);
	} catch {
		return null;
	}

	// local names bound to our `stream` / `mutate` definers
	const definers = new Map<string, Kind>();
	for (const node of ast.body) {
		if (node.type === 'ImportDeclaration' && DEFINER_SOURCE_RE.test(node.source.value)) {
			for (const spec of node.specifiers) {
				if (
					spec.type === 'ImportSpecifier' &&
					(spec.imported.name === 'stream' || spec.imported.name === 'mutate')
				) {
					definers.set(spec.local.name, spec.imported.name);
				}
			}
		}
	}

	const result: Record<string, Kind> = {};
	for (const node of ast.body) {
		if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration')
			continue;
		for (const decl of node.declaration.declarations) {
			if (decl.id.type !== 'Identifier' || decl.init?.type !== 'CallExpression') continue;
			const callee = decl.init.callee;
			if (callee.type === 'Identifier' && definers.has(callee.name)) {
				result[decl.id.name] = definers.get(callee.name)!;
			}
		}
	}
	return result;
}

/**
 * Vite plugin that powers `*.socket.ts` files:
 * - transforms them into a client WS-proxy (component imports) while keeping the real
 *   server module available under a `?socket-server` query,
 * - serves a manifest of every socket module to the server runtime,
 * - generates the entry the adapters' WebSocket modules import from the server build — the
 *   `websocket` handler factory and the resolved `socket.config` hooks,
 * - serves the WebSocket endpoint on the Vite dev server itself (same origin, plain Node),
 *   applying the same `socket.config` hooks as production.
 */
export function sveltekitSocket(options: SocketPluginOptions = {}): Plugin {
	let root = process.cwd();
	let configFile: string | null = null;
	const runtime = options.runtime ?? CLIENT_RUNTIME;

	const importSpec = (module: string) =>
		JSON.stringify(
			path
				.join(RUNTIME_DIR, module + RUNTIME_EXT)
				.split(path.sep)
				.join('/')
		);

	// The svelte-ws adapters add this plugin themselves, and an app that still lists
	// `sveltekitSocket()` in its Vite config gets a second copy. Only the first copy in the
	// resolved plugin list does anything; a second one would transform every module twice.
	let active = true;

	const plugin: Plugin = {
		name: PLUGIN_NAME,
		enforce: 'post',

		configResolved(config) {
			const first = config.plugins?.find((candidate) => candidate.name === PLUGIN_NAME);
			active = (first ?? plugin) === plugin;
			root = config.root;
			configFile = findConfigFile(root, options.config);
		},

		resolveId(id) {
			if (!active) return;
			if (id === MANIFEST_ID) return RESOLVED_MANIFEST;
			if (id === ENTRY_ID) return ENTRY_ID;
		},

		load(id) {
			if (!active) return;
			if (id === ENTRY_ID) {
				return [
					`import { createWebSocketHandler } from ${importSpec('server/ws-handler')};`,
					`import { createResolver } from ${importSpec('server/registry')};`,
					`import { modules } from ${JSON.stringify(MANIFEST_ID)};`,
					configFile ? `import config from ${JSON.stringify(configFile)};` : `const config = null;`,
					`export { config };`,
					`export { resolveHooks } from ${importSpec('config')};`,
					`export { attachNodeWebSocket } from ${importSpec('server/node-ws')};`,
					`export { ENDPOINT_PATH } from ${importSpec('protocol')};`,
					`export { configureDefaultPubSub } from ${importSpec('pubsub')};`,
					// own keys only: `id` comes from the client, and `modules.constructor` & co. are
					// not socket modules. An unknown id resolves to nothing ("Unknown stream") before
					// the cache, which would otherwise keep every string a client ever sent.
					`const load = createResolver((id) => modules[id]());`,
					`const resolve = (id, name) => (Object.hasOwn(modules, id) ? load(id, name) : undefined);`,
					// a factory, not a handler: limits and handleError only exist once
					// `socket.config` has been resolved
					`export const createWebSocket = (options) => createWebSocketHandler({ resolve, ...options });`,
					``
				].join('\n');
			}
			if (id === RESOLVED_MANIFEST) {
				const files = collectSocketFiles(root);
				const entries = files
					.map((file) => {
						const moduleId = toModuleId(file, root);
						const spec = file.split(path.sep).join('/') + '?' + SERVER_QUERY;
						return `\t${JSON.stringify(moduleId)}: () => import(${JSON.stringify(spec)})`;
					})
					.join(',\n');
				return `export const modules = {\n${entries}\n};\n`;
			}
		},

		transform(code, id, transformOptions) {
			if (!active) return;
			const [file, query] = splitId(id);
			if (!isSocketFile(file)) return null;
			const ssr = Boolean(transformOptions?.ssr);
			// The server graph's `?socket-server` import keeps the real module (descriptors); a
			// browser asking for it in dev gets the stubs like any other import.
			if (ssr && query.split('&').includes(SERVER_QUERY)) return null;
			// Vitest's server-side tests (`svelte-ws/testing`) need the handlers themselves.
			if (ssr && VITEST) return null;

			// Component import -> client WS-proxy stub.
			const kinds = classifyExports.call(this, code);
			if (!kinds) {
				this.error(
					`[svelte-ws] Could not parse ${path.relative(root, file)} to generate client stubs.`
				);
			}
			const moduleId = toModuleId(file, root);
			const names = Object.keys(kinds!);

			if (names.length === 0) {
				this.warn(`[svelte-ws] ${path.relative(root, file)} exports no stream()/mutate().`);
				return 'export {};\n';
			}

			const needsStream = names.some((n) => kinds![n] === 'stream');
			const needsMutate = names.some((n) => kinds![n] === 'mutate');
			const imports = [needsStream && 'createStream', needsMutate && 'createMutate']
				.filter(Boolean)
				.join(', ');

			const lines = [`import { ${imports} } from ${JSON.stringify(runtime)};`];
			for (const name of names) {
				const factory = kinds![name] === 'stream' ? 'createStream' : 'createMutate';
				lines.push(
					`export const ${name} = ${factory}(${JSON.stringify(moduleId)}, ${JSON.stringify(name)});`
				);
			}
			return { code: lines.join('\n') + '\n', map: null };
		},

		configureServer(server) {
			if (!active) return;
			setupDevWebSocket(server, root, configFile);

			// keep the manifest fresh as socket files come and go
			const refresh = (file: string) => {
				if (!isSocketFile(file)) return;
				const mod = server.moduleGraph.getModuleById(RESOLVED_MANIFEST);
				if (mod) void server.reloadModule(mod);
			};
			server.watcher.on('add', refresh);
			server.watcher.on('unlink', refresh);
		}
	};
	return plugin;
}

// ---- dev server ----------------------------------------------------------

/**
 * Serve the WebSocket endpoint on the Vite dev server itself (same origin — no extra port,
 * no Bun requirement in dev). Handlers load through `ssrLoadModule(...?socket-server)` so
 * HMR applies, and the transport is the very same `attachNodeWebSocket` bridge the Node
 * adapter uses in production: identical upgrade semantics everywhere.
 */
function setupDevWebSocket(server: ViteDevServer, root: string, configFile: string | null): void {
	const httpServer = server.httpServer;
	if (!httpServer) return; // middleware mode — the embedding server owns upgrades

	// Only module ids the manifest actually knows about may be loaded. The client sends this
	// string on the wire, so without an allowlist it's a path straight into `ssrLoadModule`,
	// able to run the top-level code of any local module the dev process can read.
	const knownModules = new Set(collectSocketFiles(root).map((file) => toModuleId(file, root)));
	server.watcher.on('add', (file) => {
		if (isSocketFile(file)) knownModules.add(toModuleId(file, root));
	});
	server.watcher.on('unlink', (file) => {
		if (isSocketFile(file)) knownModules.delete(toModuleId(file, root));
	});

	const resolve = createResolver(
		(moduleId) => {
			if (!knownModules.has(moduleId)) {
				return Promise.reject(new Error(`Unknown socket module: ${moduleId}`));
			}
			return server.ssrLoadModule(
				path.resolve(root, moduleId) + '?' + SERVER_QUERY
			) as Promise<ModuleExports>;
		},
		{ cache: false }
	);

	type Loaded = { hooks: SocketServerHooks; handler: ReturnType<typeof createWebSocketHandler> };
	let loading: Promise<Loaded> | null = null;
	let cleanup: InitCleanup | undefined;
	let pubsubSized = false;

	const runCleanup = async () => {
		const done = cleanup;
		cleanup = undefined;
		try {
			await done?.();
		} catch (error) {
			server.config.logger.error(`[svelte-ws] socket.config cleanup failed: ${error}`);
		}
	};

	async function load(): Promise<Loaded> {
		let hooks: SocketServerHooks = {};
		if (configFile) {
			// a reload must read the file as saved, not the copy Vite evaluated last time
			for (const mod of server.moduleGraph.getModulesByFile(configFile) ?? []) {
				server.moduleGraph.invalidateModule(mod);
			}
			const mod = await server.ssrLoadModule(configFile);
			hooks = await resolveHooks(mod.default ?? null, { dev: true });
		}
		const returned = await hooks.init?.({ dev: true });
		if (typeof returned === 'function') cleanup = returned;
		// once only: a fresh engine on a later reload would strand the running subscriptions
		if (!pubsubSized) {
			pubsubSized = true;
			configureDefaultPubSub(hooks.limits?.maxQueuedMessages);
		}
		// one handler per load, as in production, so a `websocket` wrapper runs once
		const handler = createWebSocketHandler({
			resolve,
			limits: hooks.limits,
			handleError: hooks.handleError,
			// dev matches SvelteKit's behaviour: real errors in the browser; production
			// keeps the redaction
			exposeErrors: true
		});
		return { hooks, handler: hooks.websocket?.(handler) ?? handler };
	}

	// A `socket.config` that fails to load or init must not fall back to defaults — the
	// hooks it never got to install (`upgrade` most of all) may be exactly what kept a
	// connection out. Every upgrade is rejected instead until the config loads cleanly.
	const failed: Loaded = {
		hooks: {
			upgrade: () =>
				new Response('Internal Server Error: socket.config failed to initialize', { status: 500 })
		},
		handler: createWebSocketHandler({ resolve })
	};

	const current = () =>
		(loading ??= load().catch((error): Loaded => {
			server.config.logger.error(`[svelte-ws] socket.config init failed: ${error}`);
			return failed;
		}));

	// run init eagerly once the dev server is up, not lazily on the first connection
	httpServer.once('listening', () => void current());

	// an edited (or fixed) socket.config applies on save: clean up, then load it again
	if (configFile) {
		const watched = path.resolve(configFile);
		server.watcher.on('change', (file) => {
			if (path.resolve(file) !== watched) return;
			void (async () => {
				await loading;
				await runCleanup();
				loading = null;
				await current();
			})();
		});
	}

	const closeSockets = attachNodeWebSocket({
		server: httpServer,
		endpoint: ENDPOINT_PATH,
		dev: true,
		runtime: current,
		onError: (error) => server.config.logger.error(`[svelte-ws] websocket error: ${error}`)
	});

	// a restarted dev server must not leave the old connections (and their streams) behind
	httpServer.once('close', () => {
		void closeSockets();
		void runCleanup();
	});
}
