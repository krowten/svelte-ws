/**
 * The entry the `sveltekitSocket()` Vite plugin generates for the server build (see `vite.ts`).
 * The adapters' WebSocket modules are bundled into that same build, so they import it
 * statically.
 */
declare module 'virtual:svelte-ws/entry' {
	import type { SocketServerConfig, SocketServerHooks } from '../config.js';
	import type { SocketWebSocketHandler } from '../server/ws-handler.js';

	export const config: SocketServerConfig | null;
	export const resolveHooks: typeof import('../config.js').resolveHooks;
	export const attachNodeWebSocket: typeof import('../server/node-ws.js').attachNodeWebSocket;
	export const configureDefaultPubSub: typeof import('../pubsub.js').configureDefaultPubSub;
	export const ENDPOINT_PATH: string;
	export function createWebSocket(options: {
		limits?: SocketServerHooks['limits'];
		handleError?: SocketServerHooks['handleError'];
	}): SocketWebSocketHandler;
}
