import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Issue } from './protocol.js';
import type { SocketData } from './index.js';

/**
 * Context passed as the 2nd argument to every `stream`/`mutate` handler.
 *
 * Pub/sub is intentionally *not* here — import `publish`/`subscribe` from
 * `svelte-ws/pubsub` inside the body instead. `signal` aborts when the client unsubscribes
 * or disconnects; `request` is the WebSocket upgrade request (headers / cookies / auth);
 * `data` is whatever the `upgrade` hook in `socket.config.ts` attached to the connection.
 */
export type SocketContext = {
	signal: AbortSignal;
	request: Request;
	/** See {@link SocketData} for typing this from your own `socket.config.ts`. */
	data: SocketData;
	/**
	 * Cursor of the last value the client received before it reconnected, or `undefined` on
	 * a fresh subscription. Only ever set for streams declaring a `cursor` — replay from
	 * here to close the gap a disconnect leaves. See {@link StreamOptions}.
	 */
	since?: unknown;
};

/** Extra behaviour a `stream` can opt into. */
export type StreamOptions<T> = {
	/**
	 * Derive a resume point from each value. The client remembers the last one and sends it
	 * back as `ctx.since` when it re-subscribes after a reconnect, so the handler can replay
	 * what the client missed.
	 *
	 * Replays may overlap — key your UI by id and treat delivery as at-least-once.
	 */
	cursor(value: T): unknown;
};

export type StreamHandler<Args, T> = (
	args: Args,
	ctx: SocketContext
) => AsyncIterable<T> | AsyncIterableIterator<T>;

export type MutateHandler<Args, R> = (args: Args, ctx: SocketContext) => R | Promise<R>;

export type StreamDescriptor<Args = unknown, T = unknown> = {
	kind: 'stream';
	schema: StandardSchemaV1 | null;
	handler: StreamHandler<Args, T>;
	options?: StreamOptions<T>;
};

export type MutateDescriptor<Args = unknown, R = unknown> = {
	kind: 'mutate';
	schema: StandardSchemaV1 | null;
	handler: MutateHandler<Args, R>;
};

export type AnyDescriptor = StreamDescriptor | MutateDescriptor;

// ---- client-facing handles (returned by the generated stubs) -------------

/**
 * Where the shared connection currently is. `connected` is the boolean shorthand for
 * `status === 'open'`.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Reactive handle returned by a client `stream` stub. Like SvelteKit's `query.live`:
 * `current` is the latest value, plus `error`/`connected`/`reconnect()`. Also async-iterable
 * for imperative `for await` consumption.
 */
export type Stream<T> = AsyncIterable<T> & {
	/** Latest value received, or `undefined` before the first value. */
	readonly current: T | undefined;
	/** Last error for this stream, if any. */
	readonly error: Issue[] | undefined;
	/** Whether the underlying socket is currently connected (`status === 'open'`). */
	readonly connected: boolean;
	/**
	 * Finer-grained connection state, for UI that distinguishes a first connection from a
	 * retry: `connecting` → `open` → `reconnecting` → `open`, and `closed` while nothing is
	 * subscribed.
	 */
	readonly status: ConnectionStatus;
	/** Force a reconnect of the shared socket. */
	reconnect(): void;
};

/** Client-facing type of a `stream` export: call it to get a reactive {@link Stream}. */
export type StreamFn<Args, T> = (args: Args) => Stream<T>;

/** Client-facing type of a `mutate` export: call it to await the result. */
export type MutateFn<Args, R> = (args: Args) => Promise<R>;

export type { Issue };
