/**
 * `svelte-ws/testing` — drive your `*.socket.ts` modules without a server.
 *
 * The transport is just bytes over a socket, so a test can hold both ends in memory: this
 * runs the very same `SocketConnection` production runs, with your real handlers, real
 * schemas, the real pub/sub bus and the real `upgrade` hook. What it skips is HTTP.
 *
 * ```ts
 * import { createTestClient } from 'svelte-ws/testing';
 * import * as chat from './chat.socket.js';
 *
 * const client = createTestClient({ modules: { 'chat.socket.ts': chat } });
 *
 * await expect(client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'hi' }))
 *   .resolves.toMatchObject({ text: 'hi' });
 *
 * const feed = client.stream('chat.socket.ts', 'messages', { room: 'a' });
 * await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'yo' });
 * expect((await feed.next()).value).toMatchObject({ text: 'yo' });
 * await feed.close();
 *
 * await client.close();
 * ```
 */
import { parseMessage, type ClientMessage, type ServerMessage } from './protocol.js';
import type { SocketLimits, SocketServerHooks } from './config.js';
import { createSocketConnection, type SocketConnection } from './server/connection.js';
import { createResolver, type ModuleExports } from './server/registry.js';
import { fromIssues, type SocketError } from './error.js';

export type TestClientOptions = {
	/**
	 * The socket modules under test, keyed the way the client addresses them. Import them
	 * normally — in a test there is no Vite plugin to swap them for client stubs.
	 */
	modules: Record<string, ModuleExports>;
	/** Hooks to exercise, exactly as `socket.config.ts` would export them. */
	hooks?: SocketServerHooks;
	/** The upgrade request handlers see as `ctx.request`. */
	request?: Request;
	/** Per-connection guard rails; defaults match production. */
	limits?: Partial<SocketLimits>;
	/**
	 * Show real error messages instead of `Internal Error` — on by default here, since a
	 * redacted message tells a failing test nothing.
	 */
	exposeErrors?: boolean;
};

/** A live stream you can pull values from, and close when the test is done. */
export type TestStream<T = unknown> = AsyncIterableIterator<T> & {
	/** Values received so far, in order. */
	readonly received: T[];
	/** Unsubscribe, exactly as a client going away would. */
	close(): Promise<void>;
};

export type TestClient = {
	/** Call a `mutate` export and await its result. */
	mutate<R = unknown>(module: string, exportName: string, payload?: unknown): Promise<R>;
	/** Start a `stream` export. Pass `since` to exercise the resume path. */
	stream<T = unknown>(
		module: string,
		exportName: string,
		payload?: unknown,
		options?: { since?: unknown }
	): TestStream<T>;
	/** Every frame the server sent, for assertions about the protocol itself. */
	readonly sent: ServerMessage[];
	/** Disconnect, aborting anything still running — call it in `afterEach`. */
	close(): Promise<void>;
};

/**
 * Run socket modules against an in-memory connection. Returns a client that speaks the same
 * protocol a browser would.
 */
export function createTestClient(options: TestClientOptions): TestClient {
	const sent: ServerMessage[] = [];
	const pendingMutations = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	const streams = new Map<string, StreamSink>();
	let counter = 0;
	let closed = false;

	const hooks = options.hooks ?? {};
	const resolve = createResolver(async (id) => {
		const module = options.modules[id];
		if (!module)
			throw new Error(`[svelte-ws/testing] no module registered as ${JSON.stringify(id)}`);
		return module;
	});

	function deliver(message: ServerMessage): void {
		sent.push(message);
		switch (message.type) {
			case 'ping':
				// answer keepalive like the real client does, or the server drops a test that
				// runs past pingInterval + pongTimeout (25s by default)
				void ready.then((connection) => connection.handleMessage(JSON.stringify({ type: 'pong' })));
				break;
			case 'next':
				streams.get(message.id)?.push(message.payload, message.cursor);
				break;
			case 'complete':
				streams.get(message.id)?.end();
				break;
			case 'result':
				pendingMutations.get(message.id)?.resolve(message.payload);
				pendingMutations.delete(message.id);
				break;
			case 'error': {
				const mutation = pendingMutations.get(message.id);
				if (mutation) {
					mutation.reject(fromIssues(message.errors));
					pendingMutations.delete(message.id);
				} else {
					streams.get(message.id)?.fail(fromIssues(message.errors));
				}
				break;
			}
		}
	}

	const request = options.request ?? new Request('http://localhost/_events');

	/**
	 * The `upgrade` hook decides `ctx.data`, and a connection takes that at construction —
	 * so the hook runs first and everything else waits on this.
	 */
	const ready = (async (): Promise<SocketConnection> => {
		const result = await hooks.upgrade?.({ request, server: null, dev: true });
		if (result instanceof Response) {
			throw new Error(
				`[svelte-ws/testing] the upgrade hook rejected the connection (${result.status})`
			);
		}

		const connection = createSocketConnection({
			socket: {
				send: (data) => {
					const message = parseMessage<ServerMessage>(data);
					if (message) deliver(message);
				},
				close: () => void teardown()
			},
			request,
			data: result?.data,
			resolve,
			// `hooks.limits` first, so a socket.config actually under test still gates
			// operations the way production would; explicit `options.limits` override it per
			// key, for a test that wants to exercise the guard rails themselves
			limits: { ...hooks.limits, ...options.limits },
			handleError: hooks.handleError,
			exposeErrors: options.exposeErrors ?? true
		});

		await connection.handleMessage(JSON.stringify({ type: 'connection_init' }));
		return connection;
	})();
	// a rejected upgrade surfaces from the first `mutate`/`stream`, not as an unhandled rejection
	ready.catch(() => {});

	async function send(message: ClientMessage): Promise<void> {
		if (closed) throw new Error('[svelte-ws/testing] the client is closed');
		const connection = await ready;
		await connection.handleMessage(JSON.stringify(message));
	}

	async function teardown(): Promise<void> {
		if (closed) return;
		closed = true;
		for (const sink of streams.values()) sink.end();
		streams.clear();
		for (const mutation of pendingMutations.values()) {
			mutation.reject(fromIssues([{ message: 'Connection closed' }]));
		}
		pendingMutations.clear();
		// a connection the upgrade hook refused never existed, so there's nothing to dispose
		(await ready.catch(() => null))?.dispose();
	}

	return {
		sent,

		async mutate<R>(module: string, exportName: string, payload?: unknown): Promise<R> {
			const id = `m${counter++}`;
			const result = new Promise<unknown>((resolve, reject) => {
				pendingMutations.set(id, { resolve, reject });
			});
			try {
				await send({ type: 'mutate', id, module, export: exportName, payload });
			} catch (error) {
				// never sent, so nothing will settle `result`; drop it before `close()` rejects it
				pendingMutations.delete(id);
				result.catch(() => {});
				throw error;
			}
			return result as Promise<R>;
		},

		stream<T>(
			module: string,
			exportName: string,
			payload?: unknown,
			streamOptions?: { since?: unknown }
		): TestStream<T> {
			const id = `s${counter++}`;
			const sink = createStreamSink<T>(async () => {
				streams.delete(id);
				if (!closed) await send({ type: 'complete', id });
			});
			streams.set(id, sink as StreamSink);

			// nothing awaits the subscribe frame, so a failure has to land on the stream
			// itself — otherwise it escapes as an unhandled rejection
			void send({
				type: 'stream',
				id,
				module,
				export: exportName,
				payload,
				...(streamOptions?.since === undefined ? {} : { since: streamOptions.since })
			}).catch((error: unknown) =>
				sink.fail(fromIssues([{ message: error instanceof Error ? error.message : String(error) }]))
			);

			return sink.stream;
		},

		close: teardown
	};
}

type StreamSink = {
	push(value: unknown, cursor?: unknown): void;
	fail(error: SocketError): void;
	end(): void;
};

/** A pushable async iterator with the values it has seen, plus an unsubscribe. */
function createStreamSink<T>(onClose: () => Promise<void>): {
	stream: TestStream<T>;
	push(value: unknown, cursor?: unknown): void;
	fail(error: SocketError): void;
	end(): void;
} {
	const queue: T[] = [];
	const received: T[] = [];
	let pending: ((result: IteratorResult<T>) => void) | null = null;
	let failure: ((error: unknown) => void) | null = null;
	let error: SocketError | null = null;
	let ended = false;

	// Ends anything still waiting on `next()` — shared by `close()`/`return()`, so neither one
	// can leave a caller awaiting a promise that will now never settle on its own.
	function settlePending(): void {
		if (pending) {
			pending({ value: undefined as never, done: true });
			pending = failure = null;
		}
	}

	const stream: TestStream<T> = {
		get received() {
			return received;
		},
		next() {
			if (queue.length) return Promise.resolve({ value: queue.shift() as T, done: false });
			if (error) return Promise.reject(error);
			if (ended) return Promise.resolve({ value: undefined as never, done: true });
			return new Promise<IteratorResult<T>>((resolve, reject) => {
				pending = resolve;
				failure = reject;
			});
		},
		async return() {
			ended = true;
			settlePending();
			await onClose();
			return { value: undefined as never, done: true };
		},
		close() {
			ended = true;
			settlePending();
			return onClose();
		},
		[Symbol.asyncIterator]() {
			return stream;
		}
	};

	return {
		stream,
		push(value) {
			received.push(value as T);
			if (pending) {
				pending({ value: value as T, done: false });
				pending = failure = null;
			} else {
				queue.push(value as T);
			}
		},
		fail(reason) {
			error = reason;
			if (failure) {
				failure(reason);
				pending = failure = null;
			}
		},
		end() {
			ended = true;
			settlePending();
		}
	};
}
