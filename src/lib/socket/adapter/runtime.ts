import type { InitCleanup, SocketServerHooks } from '../config.js';
import type { SocketWebSocketHandler } from '../server/ws-handler.js';

import process from 'node:process';
import * as entry from 'virtual:svelte-ws/entry';

export type StartedSocket = {
	hooks: SocketServerHooks;
	/** The handler after the `websocket` hook wrapped it. */
	websocket: SocketWebSocketHandler;
	endpoint: string;
};

/**
 * The part of production startup both adapters share: resolve `socket.config`, run its
 * `init`, size the default pub/sub engine and build the WebSocket handler. `init`'s cleanup
 * runs on SvelteKit's `sveltekit:shutdown` event, which both official adapters emit once
 * their server has stopped.
 */
export async function startSocket(): Promise<StartedSocket> {
	const hooks = await entry.resolveHooks(entry.config, { dev: false });

	const returned = await hooks.init?.({ dev: false });
	const cleanup: InitCleanup | undefined = typeof returned === 'function' ? returned : undefined;
	if (cleanup) {
		process.once('sveltekit:shutdown' as never, () => {
			Promise.resolve()
				.then(cleanup)
				.catch((error) => console.error('[svelte-ws] socket.config cleanup failed:', error));
		});
	}

	// after init, so a custom engine installed there (setPubSub) is never overridden
	entry.configureDefaultPubSub(hooks.limits?.maxQueuedMessages);

	let websocket = entry.createWebSocket({ limits: hooks.limits, handleError: hooks.handleError });
	if (hooks.websocket) websocket = hooks.websocket(websocket);

	return { hooks, websocket, endpoint: entry.ENDPOINT_PATH };
}

/** The close frame both adapters send to live sockets when the server shuts down. */
export const SHUTDOWN_CLOSE = { code: 1001, reason: 'server shutting down' } as const;
