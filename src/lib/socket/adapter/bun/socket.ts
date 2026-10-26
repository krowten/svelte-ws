import type { Server } from 'bun';
import type { SocketLike, WsData } from '../../server/ws-handler.js';

import { sameOriginCheck } from '../../config.js';
import { SHUTDOWN_CLOSE, startSocket } from '../runtime.js';

type BunOptions = Record<string, unknown> & {
	fetch: (request: Request, server: Server<WsData>) => Response | Promise<Response>;
};

function isUpgrade(request: Request): boolean {
	return (
		request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
		(request.headers.get('connection')?.toLowerCase().includes('upgrade') ?? false)
	);
}

/**
 * Called by the forked `@sveltejs/adapter-bun` runtime (`upstream/src/index.js`) right
 * before `Bun.serve(options)`: adds the WebSocket endpoint to `options`. Upstream doesn't
 * expose `websocket` at all, which is the one reason this adapter is a fork.
 *
 * Returns what graceful shutdown needs: a way to close live sockets with 1001, since
 * `server.stop()` waits for them and a WebSocket never finishes on its own.
 */
export async function installWebSocket(options: BunOptions): Promise<{ close(): void }> {
	const { hooks, websocket, endpoint } = await startSocket();

	const sockets = new Set<SocketLike<WsData>>();
	const fetch = options.fetch;

	options.websocket = {
		...websocket,
		open(ws: SocketLike<WsData>) {
			sockets.add(ws);
			return websocket.open?.(ws);
		},
		close(ws: SocketLike<WsData>, code: number, reason: string) {
			sockets.delete(ws);
			return websocket.close?.(ws, code, reason);
		}
	};

	options.fetch = async (request, server) => {
		if (!isUpgrade(request) || new URL(request.url).pathname !== endpoint) {
			return fetch(request, server);
		}

		const origin = request.headers.get('origin');
		const ctx = { request, server, dev: false };
		const allowed = hooks.checkOrigin
			? await hooks.checkOrigin(origin, ctx)
			: sameOriginCheck(origin, ctx);
		if (!allowed) return new Response('Forbidden', { status: 403 });

		const result = await hooks.upgrade?.(ctx);
		if (result instanceof Response) return result;
		const upgraded = server.upgrade(request, {
			data: { request, data: result?.data },
			headers: result?.headers
		});
		// Bun sends the 101 itself; returning nothing after a successful upgrade is the contract
		return upgraded
			? (undefined as unknown as Response)
			: new Response('WebSocket upgrade failed', { status: 400 });
	};

	return {
		close() {
			for (const ws of sockets) ws.close(SHUTDOWN_CLOSE.code, SHUTDOWN_CLOSE.reason);
		}
	};
}
