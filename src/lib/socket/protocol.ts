/**
 * Wire protocol for the single multiplexed WebSocket connection.
 *
 * Inspired by graphql-ws: one connection carries many operations, each tagged with a
 * client-generated `id`. The handshake is `connection_init` -> `connection_ack`, and either
 * side may send `ping`/`pong` for app-level keepalive (independent of the transport's own
 * protocol pings).
 *
 * This module is transport-agnostic and safe to import from both client and server.
 */

/** Path the single WebSocket connects to (same in dev and prod). */
export const ENDPOINT_PATH = '/_events';

/** Default app-level keepalive timings (ms). */
export const PING_INTERVAL_MS = 15_000;
export const PONG_TIMEOUT_MS = 10_000;

/** Close code used when the peer fails to answer pings in time. */
export const CLOSE_PONG_TIMEOUT = 4408;

/**
 * Close code for a client that starts an operation under an id still in use. Any answer
 * under that id would read as the end of the original operation, so the connection goes,
 * as in graphql-ws.
 */
export const CLOSE_DUPLICATE_ID = 4409;

export type Issue = {
	message: string;
	path?: ReadonlyArray<PropertyKey>;
};

// ---- client -> server ----------------------------------------------------

export type ConnectionInit = { type: 'connection_init' };

/** Start a long-lived stream. */
export type StreamMessage = {
	type: 'stream';
	id: string;
	module: string;
	export: string;
	payload?: unknown;
	/**
	 * Cursor of the last value this client actually received, sent when re-subscribing after
	 * a reconnect so the handler can replay what was missed. Only present for streams that
	 * declare a `cursor` — see `stream(schema, handler, { cursor })`.
	 */
	since?: unknown;
};

/** Invoke a one-shot mutation. */
export type MutateMessage = {
	type: 'mutate';
	id: string;
	module: string;
	export: string;
	payload?: unknown;
};

/** Client asks to stop a subscription it started. */
export type ClientComplete = { type: 'complete'; id: string };

// ---- server -> client ----------------------------------------------------

export type ConnectionAck = { type: 'connection_ack' };

/** A value produced by a subscription. */
export type NextMessage = {
	type: 'next';
	id: string;
	payload: unknown;
	/** Resume point for this value, when the stream declares a `cursor`. */
	cursor?: unknown;
};

/** The single value produced by a mutation. */
export type ResultMessage = { type: 'result'; id: string; payload: unknown };

/** An operation failed (validation, unknown op, thrown error). */
export type ErrorMessage = { type: 'error'; id: string; errors: Issue[] };

/** A subscription ended (server side). */
export type ServerComplete = { type: 'complete'; id: string };

// ---- shared --------------------------------------------------------------

export type Ping = { type: 'ping' };
export type Pong = { type: 'pong' };

export type ClientMessage =
	ConnectionInit | StreamMessage | MutateMessage | ClientComplete | Ping | Pong;

export type ServerMessage =
	ConnectionAck | NextMessage | ResultMessage | ErrorMessage | ServerComplete | Ping | Pong;

const decoder = new TextDecoder();

/** Parse a raw frame into a message, or `null` if it isn't valid JSON / shape. */
export function parseMessage<T extends { type: string }>(
	raw: string | ArrayBufferLike | Uint8Array
): T | null {
	let text: string;
	if (typeof raw === 'string') {
		text = raw;
	} else if (raw instanceof Uint8Array) {
		text = decoder.decode(raw);
	} else {
		text = decoder.decode(new Uint8Array(raw));
	}
	try {
		const msg = JSON.parse(text);
		return msg && typeof msg.type === 'string' ? (msg as T) : null;
	} catch {
		return null;
	}
}
