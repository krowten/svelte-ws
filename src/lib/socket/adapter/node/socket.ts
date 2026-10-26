import type { Server } from 'node:http';

import process from 'node:process';
import { attachNodeWebSocket } from 'virtual:svelte-ws/entry';
import { startSocket } from '../runtime.js';

/**
 * Bundled into the server build next to `@sveltejs/adapter-node`'s own runtime and imported
 * by `build/index.js` before that runtime, so `socket.config`'s `init` finishes (top-level
 * await) before the server starts listening.
 */
const { hooks, websocket, endpoint } = await startSocket();

/**
 * Serve the WebSocket endpoint on adapter-node's HTTP server. Everything else about that
 * server (listening, env vars, static files, graceful shutdown) stays adapter-node's.
 */
export function attach(server: Server): void {
	const close = attachNodeWebSocket({
		server,
		endpoint,
		dev: false,
		runtime: () => ({ hooks, handler: websocket }),
		onError: (error) => console.error('[svelte-ws] upgrade failed:', error)
	});

	// adapter-node's shutdown waits for open connections before it lets go of the process,
	// and a WebSocket never goes idle on its own: close them (1001) as soon as it starts
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close());
}
