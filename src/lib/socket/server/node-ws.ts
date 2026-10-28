import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { SocketServerHooks } from '../config.js';
import type { SocketLike, SocketWebSocketHandler, WsData } from './ws-handler.js';

import { DEFAULT_LIMITS, sameOriginCheck } from '../config.js';

/**
 * Anything with an `upgrade` event: `node:http`/`node:https`/`http2` servers all qualify,
 * which is what lets Vite's dev server and the adapter share this bridge.
 */
export type UpgradableServer = {
	on(
		event: 'upgrade',
		listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
	): unknown;
};

/** What the bridge needs per connection — resolved lazily so dev can load hooks on demand. */
export type NodeWebSocketRuntime = {
	hooks: SocketServerHooks;
	handler: SocketWebSocketHandler;
};

export type NodeWebSocketOptions = {
	/** The HTTP server whose `upgrade` events we handle. */
	server: UpgradableServer;
	/** Only upgrades to this pathname are handled; everything else is left alone. */
	endpoint: string;
	dev: boolean;
	/** Hooks + handler; called per upgrade, so dev can pick up config changes. */
	runtime(): NodeWebSocketRuntime | Promise<NodeWebSocketRuntime>;
	onError?(error: unknown): void;
};

/** Build a fetch `Request` from a Node upgrade request and its already-parsed target. */
function toFetchRequest(req: IncomingMessage, target: URL, secure: boolean): Request {
	const host = req.headers.host ?? 'localhost';
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === 'string') headers.set(name, value);
		else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
	}
	return new Request(`${secure ? 'https' : 'http'}://${host}${target.pathname}${target.search}`, {
		headers
	});
}

/** Headers `writeRawResponse` sets itself; a copy from the hook's `Response` would duplicate them. */
const FRAMING_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

/** Write a raw HTTP/1.1 response to a socket — used to reject an upgrade. */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
	const body = await response.text();
	if (socket.destroyed) return; // the client hung up while the hooks ran
	const lines = [`HTTP/1.1 ${response.status} ${response.statusText || 'Rejected'}`];
	response.headers.forEach((value, name) => {
		if (!FRAMING_HEADERS.has(name)) lines.push(`${name}: ${value}`);
	});
	lines.push(`content-length: ${Buffer.byteLength(body)}`, 'connection: close', '', body);
	socket.write(lines.join('\r\n'));
	socket.end();
}

/** Normalise a `ws` message payload into what `SocketConnection` accepts. */
function toRaw(payload: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (Array.isArray(payload)) return Buffer.concat(payload);
	if (payload instanceof ArrayBuffer) return Buffer.from(payload);
	return payload;
}

/**
 * Run a lifecycle callback (ours or a user `websocket` wrapper's) without letting a sync
 * throw or a rejected promise become an unhandled error — either would otherwise take the
 * whole Node process down via `EventEmitter`'s default `error`/`unhandledRejection` handling.
 */
function guard(
	onError: ((error: unknown) => void) | undefined,
	fn: () => void | Promise<void>
): void {
	try {
		const result = fn();
		if (result && typeof (result as Promise<void>).catch === 'function') {
			(result as Promise<void>).catch((error) => onError?.(error));
		}
	} catch (error) {
		onError?.(error);
	}
}

/**
 * The subset of Bun's `ServerWebSocket` our handler (and typical `websocket` wrappers) use,
 * backed by a `ws` socket. Topic pub/sub is a no-op here — use `svelte-ws/pubsub`, which
 * works on every runtime.
 */
function socketFacade(ws: import('ws').WebSocket, data: WsData): SocketLike {
	const facade = {
		data,
		send(message: string | ArrayBufferLike) {
			ws.send(message as string | ArrayBuffer);
			return typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
		},
		close: (code?: number, reason?: string) => ws.close(code, reason),
		terminate: () => ws.terminate(),
		getBufferedAmount: () => ws.bufferedAmount,
		get readyState() {
			return ws.readyState;
		},
		remoteAddress: '',
		subscribe: () => {},
		unsubscribe: () => {},
		isSubscribed: () => false,
		publish: () => 0,
		ping: () => 0,
		pong: () => 0,
		cork: <T>(callback: (ws: SocketLike) => T): T => callback(facade),
		binaryType: 'nodebuffer' as const
	};
	return facade;
}

/**
 * Serve the socket endpoint on a `node:http` server using the `ws` package, driving the same
 * Bun-shaped handler the Bun adapter uses. Shared by `vite dev` and the Node adapter, so the
 * upgrade semantics (`socket.config`'s `upgrade` hook, per-connection data, headers on the
 * `101`) are identical everywhere.
 *
 * `ws` is imported lazily so runtimes that never take this path don't load it.
 *
 * Returns a closer: WebSockets are long-lived, so `server.close()` would wait for them
 * forever — shutdown has to end them explicitly.
 */
export function attachNodeWebSocket(options: NodeWebSocketOptions): () => Promise<void> {
	const { server, endpoint, dev } = options;
	const extraHeaders = new WeakMap<IncomingMessage, Headers>();

	let serverPromise: Promise<import('ws').WebSocketServer> | null = null;
	const webSocketServer = async (maxPayload: number) => {
		serverPromise ??= import('ws').then(({ WebSocketServer }) => {
			// `ws` would otherwise accept 100 MB frames
			const wss = new WebSocketServer({ noServer: true, maxPayload });
			// `ws` builds the 101 response headers here — this is where the upgrade hook's
			// headers (e.g. `set-cookie`) get injected.
			wss.on('headers', (headers, req) => {
				extraHeaders.get(req)?.forEach((value, name) => headers.push(`${name}: ${value}`));
			});
			return wss;
		});
		return serverPromise;
	};

	server.on('upgrade', (req, socket, head) => {
		// Node's HTTP parser accepts some request-targets the WHATWG URL constructor rejects;
		// letting that throw here would be an uncaught exception in a synchronous event
		// listener (before any of our own error handling exists) and take the process down.
		let target: URL;
		try {
			target = new URL(req.url ?? '/', 'http://localhost');
		} catch (error) {
			options.onError?.(error);
			socket.destroy();
			return;
		}
		if (target.pathname !== endpoint) {
			// Vite's HMR socket, other apps' sockets, … — unless nobody else is listening: then
			// Node would have closed the socket itself had we not subscribed, and so do we
			if ((server as { listenerCount?(event: string): number }).listenerCount?.('upgrade') === 1) {
				socket.destroy();
			}
			return;
		}

		// Node takes its own `error` listener off the socket when it emits `upgrade`. Until `ws`
		// adds one, a client that resets the connection while the hooks run would raise an
		// uncaught `ECONNRESET` and take the process down.
		const onSocketError = (error: unknown) => {
			options.onError?.(error);
			socket.destroy();
		};
		socket.on('error', onSocketError);

		void (async () => {
			const { hooks, handler } = await options.runtime();
			const request = toFetchRequest(
				req,
				target,
				'encrypted' in socket && Boolean(socket.encrypted)
			);

			const checkOrigin = hooks.checkOrigin ?? sameOriginCheck;
			const allowed = await checkOrigin(request.headers.get('origin'), { request, server, dev });
			if (!allowed) return writeRawResponse(socket, new Response('Forbidden', { status: 403 }));

			const result = await hooks.upgrade?.({ request, server, dev });
			if (result instanceof Response) return writeRawResponse(socket, result);

			const data = result?.data;
			if (result?.headers) extraHeaders.set(req, new Headers(result.headers));

			const wss = await webSocketServer(
				(handler.maxPayloadLength as number | undefined) ?? DEFAULT_LIMITS.maxPayloadBytes
			);
			if (socket.destroyed) return;
			socket.off('error', onSocketError); // `ws` handles socket errors from here on
			wss.handleUpgrade(req, socket, head, (ws) => {
				const facade = socketFacade(ws, { request, data });
				// A rejected/oversized frame — or any other transport-level problem — emits
				// `error` on `ws`. With no listener, Node's EventEmitter throws it as an
				// uncaught exception and takes the whole process down; close just this
				// connection instead.
				ws.on('error', (error) => {
					options.onError?.(error);
					try {
						ws.terminate();
					} catch {
						// already gone
					}
				});
				guard(options.onError, () => handler.open?.(facade));
				ws.on('message', (payload: Buffer | ArrayBuffer | Buffer[]) => {
					guard(options.onError, () => handler.message(facade, toRaw(payload)));
				});
				ws.on('close', (code: number, reason: Buffer) => {
					guard(options.onError, () => handler.close?.(facade, code, reason.toString()));
				});
			});
		})().catch((error) => {
			options.onError?.(error);
			socket.destroy();
		});
	});

	return async function close() {
		if (!serverPromise) return; // nothing ever connected, so `ws` was never loaded
		const wss = await serverPromise;
		for (const client of wss.clients) client.close(1001, 'server shutting down');
		await new Promise<void>((resolve) => wss.close(() => resolve()));
	};
}
