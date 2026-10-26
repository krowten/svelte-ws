import {
	createSocketConnection,
	type SocketConnection,
	type ResolveDescriptor
} from './connection.js';
import { DEFAULT_LIMITS, type SocketLimits, type SocketServerHooks } from '../config.js';

/** Per-connection data carried on `ws.data` (set at upgrade time). */
export type WsData = {
	request: Request;
	/** Data attached by the `upgrade` hook in `socket.config.ts`. */
	data?: Record<string, unknown>;
	conn?: SocketConnection;
};

/**
 * The socket object a handler receives. Structurally a subset of Bun's `ServerWebSocket`,
 * declared here so the package carries no hard dependency on Bun's types — the Node adapter
 * and the dev server drive the same handler through a small façade over the `ws` package.
 */
export type SocketLike<Data = WsData> = {
	data: Data;
	send(message: string | ArrayBufferLike, compress?: boolean): number;
	close(code?: number, reason?: string): void;
	readonly readyState: number;
};

/**
 * A WebSocket handler in Bun's shape (`{ open, message, close, ...options }`). Extra keys
 * such as `maxPayloadLength` or `perMessageDeflate` pass through to `serve()` on Bun and are
 * ignored elsewhere.
 */
export type SocketWebSocketHandler<Data = WsData> = {
	open?(ws: SocketLike<Data>): void | Promise<void>;
	message(ws: SocketLike<Data>, message: string | Uint8Array): void | Promise<void>;
	close?(ws: SocketLike<Data>, code: number, reason: string): void | Promise<void>;
	[option: string]: unknown;
};

export type WebSocketHandlerOptions = {
	resolve: ResolveDescriptor;
	/** Per-connection guard rails from `socket.config.ts`; defaults apply to anything omitted. */
	limits?: Partial<SocketLimits>;
	/** Error hook from `socket.config.ts` — logging, plus the last word on what clients see. */
	handleError?: SocketServerHooks['handleError'];
	/** Dev only: send real error messages instead of "Internal Error". */
	exposeErrors?: boolean;
};

/**
 * Build the WebSocket handler that bridges a socket to a {@link SocketConnection}. Shaped
 * for `serve({ websocket })` on Bun; the Node adapter and the dev server feed it through
 * `attachNodeWebSocket` from `./node-ws.js`.
 */
export function createWebSocketHandler(options: WebSocketHandlerOptions): SocketWebSocketHandler {
	return {
		// Bun picks this up from the handler object; the Node bridge reads the same limit when
		// it creates its server. Without it the transports default to 16 MB / 100 MB frames.
		maxPayloadLength: options.limits?.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes,
		open(ws) {
			ws.data.conn = createSocketConnection({
				socket: {
					send: (data) => void ws.send(data),
					close: (code, reason) => ws.close(code, reason),
					get bufferedAmount() {
						// Bun reports it; the `ws` façade does too. Undefined elsewhere, which
						// simply disables the backpressure guard rather than breaking.
						return (ws as { getBufferedAmount?(): number }).getBufferedAmount?.();
					}
				},
				request: ws.data.request,
				data: ws.data.data,
				resolve: options.resolve,
				limits: options.limits,
				handleError: options.handleError,
				exposeErrors: options.exposeErrors
			});
		},
		message(ws, message) {
			// handleMessage reports its own failures today; should one ever slip through, it
			// costs this connection, not the process (an unhandled rejection is fatal on Node)
			ws.data.conn?.handleMessage(message).catch(() => ws.close(1011, 'internal error'));
		},
		close(ws) {
			ws.data.conn?.dispose();
		}
	};
}
