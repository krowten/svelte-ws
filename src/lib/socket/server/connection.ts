import type { ClientMessage, Issue, ServerMessage } from '../protocol.js';
import type { AnyDescriptor, SocketContext } from '../types.js';
import type { SocketLimits, SocketServerHooks } from '../config.js';

import {
	CLOSE_DUPLICATE_ID,
	CLOSE_PONG_TIMEOUT,
	PING_INTERVAL_MS,
	PONG_TIMEOUT_MS,
	parseMessage
} from '../protocol.js';
import { DEFAULT_LIMITS } from '../config.js';
import { isSocketError } from '../error.js';
import { runOperation } from './operation.js';
import { isValidationError, toIssues, validate } from './validate.js';

/** Close codes we originate, beyond the keepalive one in the protocol. */
const CLOSE_TOO_LARGE = 1009;
const CLOSE_BACKPRESSURE = 1011;
/** A connection that never sent `connection_init` in time — same private range as `CLOSE_PONG_TIMEOUT`. */
const CLOSE_HANDSHAKE_TIMEOUT = 4400;

/** Client-supplied strings we keep for an operation's lifetime; real ones are far shorter. */
const MAX_ID_LENGTH = 128;
const MAX_MODULE_LENGTH = 1024;
const MAX_EXPORT_LENGTH = 256;

/**
 * A stream yields to the event loop after this many frames in a row. Values that are ready at
 * once (an array, a burst on the bus) would otherwise run the whole loop in microtasks, and
 * one fast stream would hold up every other connection on the server.
 */
const FRAMES_PER_TURN = 64;
const nextTurn = () =>
	new Promise<void>((resolve) => (globalThis.setImmediate ?? setTimeout)(() => resolve()));

/** What the connection needs from the underlying socket (Bun ws, dev ws, …). */
export type ConnectionSocket = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	/**
	 * Bytes queued for the peer, when the transport can tell us. Streams pause while this
	 * stays above `limits.maxBufferedBytes`, which is what keeps a slow reader from growing
	 * the server's memory without bound.
	 */
	readonly bufferedAmount?: number;
};

export type ResolveDescriptor = (
	module: string,
	exportName: string
) => AnyDescriptor | undefined | Promise<AnyDescriptor | undefined>;

export type ConnectionOptions = {
	socket: ConnectionSocket;
	/** Original upgrade request, exposed to handlers via `ctx.request`. */
	request: Request;
	/** Per-connection data from the `upgrade` hook, exposed to handlers via `ctx.data`. */
	data?: Record<string, unknown>;
	/** Resolve a descriptor by module id + export name. */
	resolve: ResolveDescriptor;
	/** Per-connection guard rails; anything omitted keeps its default. */
	limits?: Partial<SocketLimits>;
	/** Called for every handler error — logging, and the last word on what the client sees. */
	handleError?: SocketServerHooks['handleError'];
	/**
	 * Send real error messages to the client instead of "Internal Error". The dev server
	 * turns this on — never enable it in production.
	 */
	exposeErrors?: boolean;
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
};

/** Public surface of a connection: feed it frames, dispose it on socket close. */
export type SocketConnection = {
	handleMessage(raw: string | ArrayBufferLike | Uint8Array): Promise<void>;
	dispose(): void;
};

type Kind = 'stream' | 'mutate';

/**
 * Transport-agnostic handler for one client connection. Both the production Bun WebSocket
 * handler and the dev `Bun.serve` share this — they only differ in how bytes get in and out.
 *
 * Responsibilities: the `connection_init`/`ack` handshake, ping/pong keepalive (drops the
 * socket if pongs stop), argument validation, running mutates (one `result`), and driving
 * stream async-iterables (`next`* then `complete`) with per-op `AbortController` cancellation
 * on client `complete` or disconnect. Pub/sub is not its concern — handlers use the bus.
 */
export function createSocketConnection(options: ConnectionOptions): SocketConnection {
	const { socket, request, resolve, data = {} } = options;
	const limits: SocketLimits = { ...DEFAULT_LIMITS, ...options.limits };
	const pingInterval = options.pingIntervalMs ?? PING_INTERVAL_MS;
	const pongTimeout = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;

	/** Active operations (streams + in-flight mutates) by client op id. */
	const ops = new Map<string, AbortController>();
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPong = Date.now();
	let disposed = false;
	let initialized = false;
	/**
	 * Characters of replies (anything but stream values) sent while the socket was over
	 * `maxBufferedBytes`. A client that keeps sending requests without reading the answers
	 * would otherwise grow the server's buffer for as long as it keeps sending.
	 */
	let congestedReplies = 0;

	/**
	 * Encode and send, reporting whether the frame actually went out. `false` covers two
	 * different failures: the transport is gone (caller already handled, nothing to do), or
	 * `msg`'s payload couldn't be encoded at all (BigInt, a cycle, a throwing `toJSON`) — a
	 * contract violation by a handler, not a transport problem, which the client would
	 * otherwise never hear about and be left waiting on forever.
	 */
	function send(msg: ServerMessage): boolean {
		if (disposed) return false;
		let text: string;
		try {
			text = JSON.stringify(msg);
		} catch (err) {
			report(err);
			if (
				'id' in msg &&
				typeof msg.id === 'string' &&
				msg.type !== 'error' &&
				msg.type !== 'complete'
			) {
				try {
					socket.send(
						JSON.stringify({ type: 'error', id: msg.id, errors: [{ message: 'Internal Error' }] })
					);
				} catch {
					// socket already gone
				}
			}
			return false;
		}
		if (msg.type !== 'next' && overReplyBudget(text)) return false;
		try {
			socket.send(text);
			return true;
		} catch {
			return false; // socket already gone
		}
	}

	/**
	 * Stream values pause in {@link awaitDrain} and mutation results wait there too; this is
	 * the ceiling for the replies that can't wait (errors, acks, pongs). Past another
	 * `maxBufferedBytes` of them on a congested socket, the client is not reading at all.
	 * Counts UTF-16 units rather than bytes: close enough for a ceiling, and cheap.
	 */
	function overReplyBudget(text: string): boolean {
		const buffered = socket.bufferedAmount;
		if (buffered === undefined || buffered <= limits.maxBufferedBytes) {
			congestedReplies = 0;
			return false;
		}
		congestedReplies += text.length;
		if (congestedReplies <= limits.maxBufferedBytes) return false;
		socket.close(CLOSE_BACKPRESSURE, 'client not reading');
		dispose();
		return true;
	}

	function makeContext(signal: AbortSignal, since?: unknown): SocketContext {
		return { signal, request, data, since };
	}

	function fail(id: string, kind: Kind, errors: Issue[]): void {
		send({ type: 'error', id, errors });
		if (kind === 'stream') send({ type: 'complete', id });
	}

	/**
	 * Turn a thrown value into what the client is allowed to see. Unexpected errors are
	 * redacted by {@link toIssues}; `handleError` gets the original for logging and may
	 * return issues of its own.
	 */
	function report(
		err: unknown,
		operation?: { module: string; export: string; kind: Kind }
	): Issue[] {
		let fromHook: Issue[] | void = undefined;
		try {
			fromHook = options.handleError?.(err, { request, data, operation });
		} catch (hookError) {
			console.error('[svelte-ws] handleError threw:', hookError);
		}
		// like SvelteKit: without a `handleError` hook, a bug still shows up in the server log
		if (!options.handleError && !isSocketError(err) && !isValidationError(err)) {
			const where = operation
				? ` in ${operation.kind} ${operation.module}#${operation.export}`
				: '';
			console.error(`[svelte-ws] unexpected error${where}:`, err);
		}
		return fromHook ?? toIssues(err, options.exposeErrors);
	}

	/**
	 * Wait for a congested socket to drain, so a slow reader slows the stream, not the heap.
	 * `onBackpressure: 'wait'` means wait — genuinely without a deadline — since resuming
	 * early would just grow the very queue the timeout was meant to bound. Only `'close'` has
	 * a deadline, past which the connection is dropped instead of waiting forever.
	 */
	async function awaitDrain(signal: AbortSignal): Promise<boolean> {
		if (socket.bufferedAmount === undefined) return true; // transport can't tell us
		if (socket.bufferedAmount <= limits.maxBufferedBytes) return true;

		const deadline =
			limits.onBackpressure === 'close' ? Date.now() + limits.backpressureTimeoutMs : Infinity;
		while (socket.bufferedAmount > limits.maxBufferedBytes) {
			if (signal.aborted || disposed) return false;
			if (Date.now() > deadline) {
				socket.close(CLOSE_BACKPRESSURE, 'client too slow');
				dispose();
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return true;
	}

	async function runMutate(
		id: string,
		descriptor: Extract<AnyDescriptor, { kind: 'mutate' }>,
		payload: unknown,
		operation: { module: string; export: string; kind: Kind },
		ac: AbortController
	): Promise<void> {
		try {
			const args = await validate(descriptor.schema, payload);
			// disconnect/complete landed while validation was in flight — the handler must
			// never see an operation the client already gave up on
			if (ac.signal.aborted) return;
			const result = await descriptor.handler(args, makeContext(ac.signal));
			if (ac.signal.aborted) return; // cancelled while the handler ran; the result is stale
			// a result waits for a congested socket the way a stream value does
			if (!(await awaitDrain(ac.signal))) return;
			send({ type: 'result', id, payload: result ?? null });
		} catch (err) {
			if (!ac.signal.aborted) send({ type: 'error', id, errors: report(err, operation) });
		}
	}

	async function runStream(
		id: string,
		descriptor: Extract<AnyDescriptor, { kind: 'stream' }>,
		payload: unknown,
		operation: { module: string; export: string; kind: Kind },
		ac: AbortController,
		since?: unknown
	): Promise<void> {
		let iterator: AsyncIterator<unknown> | undefined;
		let finished = false;
		// A generator's `finally` may itself reject (a failing rollback, a closed pool). Left
		// unhandled that takes the whole process down on Node, so cleanup gets its own catch.
		const end = () => {
			void Promise.resolve(iterator?.return?.()).catch((err) =>
				report(err, { ...operation, kind: 'stream' })
			);
		};
		ac.signal.addEventListener('abort', end);
		// A handler waiting on something that never settles (an idle channel it subscribed to
		// without a signal, a stuck query) must not keep its operation slot once cancelled.
		const cancelled = new Promise<null>((resolve) =>
			ac.signal.addEventListener('abort', () => resolve(null), { once: true })
		);

		try {
			const args = await validate(descriptor.schema, payload);
			if (ac.signal.aborted) return; // cancelled during validation — never started
			const toCursor = descriptor.options?.cursor;
			// only a stream that declared a cursor ever handed one out, so only it can be
			// resuming; for any other stream a `since` is noise at best, forged at worst
			const iterable = descriptor.handler(
				args,
				makeContext(ac.signal, toCursor ? since : undefined)
			);
			iterator = iterable[Symbol.asyncIterator]();

			let frames = 0;
			while (!ac.signal.aborted) {
				const step = await Promise.race([iterator.next(), cancelled]);
				if (!step || ac.signal.aborted) break;
				if (step.done) {
					finished = true;
					break;
				}
				const { value } = step;
				// a resumable stream tags every value, so the client can ask to continue from
				// the last one it actually received
				const sent = send({ type: 'next', id, payload: value, cursor: toCursor?.(value) });
				// an unencodable value already told the client what it could (an `error`
				// frame, if `id` was usable); producing more from a stream the client can't
				// read would just make the same mistake again
				if (!sent) break;
				if (!(await awaitDrain(ac.signal))) break;
				if (++frames % FRAMES_PER_TURN === 0) await nextTurn();
			}
			if (!ac.signal.aborted) send({ type: 'complete', id });
		} catch (err) {
			if (!ac.signal.aborted) fail(id, 'stream', report(err, operation));
		} finally {
			ac.signal.removeEventListener('abort', end);
			// left the loop with the handler still suspended (an unencodable value, a throwing
			// cursor, a congested socket that was closed): end it, so its own `finally` runs
			if (!finished && !ac.signal.aborted) end();
		}
	}

	async function dispatch(
		id: string,
		module: string,
		exportName: string,
		payload: unknown,
		kind: Kind,
		since?: unknown
	): Promise<void> {
		// a frame that arrives after teardown must not start fresh work — `ops` is empty by
		// then, so without this guard it would look like there's room under the cap
		if (disposed) return;

		const operation = { module, export: exportName, kind };

		if (ops.has(id)) {
			// A protocol violation: replacing the AbortController would leave the original
			// running uncancellable, and an `error`/`complete` under this id would tell the
			// client its original operation ended while it keeps sending `next`.
			socket.close(CLOSE_DUPLICATE_ID, `Subscriber for ${id.slice(0, 64)} already exists`);
			dispose();
			return;
		}
		if (ops.size >= limits.maxOperations) {
			fail(id, kind, [
				{ message: `Too many concurrent operations (limit ${limits.maxOperations})` }
			]);
			return;
		}

		const ac = new AbortController();
		ops.set(id, ac); // reserved before the first await, so the cap actually holds

		try {
			let descriptor: AnyDescriptor | undefined;
			try {
				descriptor = await resolve(module, exportName);
			} catch (err) {
				if (!ac.signal.aborted) fail(id, kind, report(err, operation));
				return;
			}

			// disconnect/complete landed while resolving — don't start a handler nobody
			// will read the result of
			if (ac.signal.aborted) return;

			if (!descriptor || descriptor.kind !== kind) {
				fail(id, kind, [{ message: `Unknown ${kind}: ${module}#${exportName}` }]);
				return;
			}

			if (kind === 'stream') {
				// `subscribe()` inside the handler picks this operation's signal up by itself
				await runOperation(ac.signal, () =>
					runStream(
						id,
						descriptor as Extract<AnyDescriptor, { kind: 'stream' }>,
						payload,
						operation,
						ac,
						since
					)
				);
			} else {
				await runMutate(
					id,
					descriptor as Extract<AnyDescriptor, { kind: 'mutate' }>,
					payload,
					operation,
					ac
				);
			}
		} finally {
			// only clear the slot if it's still ours — guards against a stale finally
			// deleting a different operation that has since reused this id
			if (ops.get(id) === ac) ops.delete(id);
		}
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		if (pingTimer) clearInterval(pingTimer);
		if (handshakeTimer) clearTimeout(handshakeTimer);
		for (const ac of ops.values()) ac.abort();
		ops.clear();
	}

	function startKeepalive(): void {
		if (pingTimer || disposed) return;
		lastPong = Date.now();
		pingTimer = setInterval(() => {
			if (Date.now() - lastPong > pingInterval + pongTimeout) {
				socket.close(CLOSE_PONG_TIMEOUT, 'keepalive timeout');
				dispose();
				return;
			}
			send({ type: 'ping' });
		}, pingInterval);
		// don't keep the process alive solely for keepalive pings
		(pingTimer as { unref?: () => void }).unref?.();
	}

	// A client that never sends `connection_init` never starts keepalive either, so without
	// its own deadline it could hold operations and a connection slot open forever. Budgeted
	// like keepalive's own timeout, since the failure mode — a peer that stopped answering —
	// is the same one.
	handshakeTimer = setTimeout(() => {
		socket.close(CLOSE_HANDSHAKE_TIMEOUT, 'handshake timeout');
		dispose();
	}, pingInterval + pongTimeout);
	(handshakeTimer as { unref?: () => void }).unref?.();

	/** Whether a frame is over `maxPayloadBytes`, counting a string's UTF-8 bytes, not its length. */
	function tooLarge(raw: string | ArrayBufferLike | Uint8Array): boolean {
		if (typeof raw !== 'string')
			return ('byteLength' in raw ? raw.byteLength : 0) > limits.maxPayloadBytes;
		// a UTF-16 code unit is 1–3 UTF-8 bytes, so only the band in between needs encoding
		if (raw.length > limits.maxPayloadBytes) return true;
		if (raw.length * 3 <= limits.maxPayloadBytes) return false;
		// Node and Bun count UTF-8 bytes without encoding a copy; the browser (tests) can't
		const bytes = globalThis.Buffer?.byteLength(raw) ?? new TextEncoder().encode(raw).byteLength;
		return bytes > limits.maxPayloadBytes;
	}

	/**
	 * A usable client-generated operation id — anything else can't even be replied to. Capped,
	 * because every in-flight id is held as a map key: without a limit one client could pin
	 * `maxOperations` near-`maxPayloadBytes` strings.
	 */
	function isValidId(id: unknown): id is string {
		return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
	}

	/** `module` / `export` of an operation: strings of sane length, or the frame is rejected. */
	function isValidTarget(module: unknown, exportName: unknown): boolean {
		return (
			typeof module === 'string' &&
			module.length <= MAX_MODULE_LENGTH &&
			typeof exportName === 'string' &&
			exportName.length <= MAX_EXPORT_LENGTH
		);
	}

	async function handleMessage(raw: string | ArrayBufferLike | Uint8Array): Promise<void> {
		if (tooLarge(raw)) {
			socket.close(CLOSE_TOO_LARGE, 'message too large');
			dispose();
			return;
		}
		if (disposed) return;

		const msg = parseMessage<ClientMessage>(raw);
		if (!msg) return;

		switch (msg.type) {
			case 'connection_init':
				initialized = true;
				if (handshakeTimer) {
					clearTimeout(handshakeTimer);
					handshakeTimer = null;
				}
				send({ type: 'connection_ack' });
				startKeepalive();
				break;
			case 'ping':
				send({ type: 'pong' });
				break;
			case 'pong':
				lastPong = Date.now();
				break;
			case 'stream':
				if (!isValidId(msg.id)) break;
				if (!initialized) {
					fail(msg.id, 'stream', [{ message: 'Send connection_init before starting operations' }]);
					break;
				}
				if (!isValidTarget(msg.module, msg.export)) {
					fail(msg.id, 'stream', [{ message: 'Invalid operation target' }]);
					break;
				}
				void dispatch(msg.id, msg.module, msg.export, msg.payload, 'stream', msg.since);
				break;
			case 'mutate':
				if (!isValidId(msg.id)) break;
				if (!initialized) {
					fail(msg.id, 'mutate', [{ message: 'Send connection_init before starting operations' }]);
					break;
				}
				if (!isValidTarget(msg.module, msg.export)) {
					fail(msg.id, 'mutate', [{ message: 'Invalid operation target' }]);
					break;
				}
				void dispatch(msg.id, msg.module, msg.export, msg.payload, 'mutate');
				break;
			case 'complete':
				if (isValidId(msg.id)) ops.get(msg.id)?.abort();
				break;
		}
	}

	return { handleMessage, dispose };
}
