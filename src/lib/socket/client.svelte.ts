import { onDestroy } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	ENDPOINT_PATH,
	PING_INTERVAL_MS,
	PONG_TIMEOUT_MS,
	parseMessage,
	type ClientMessage,
	type ServerMessage
} from './protocol.js';
import type { ConnectionStatus, Issue, MutateFn, StreamFn, Stream } from './types.js';
import { fromIssues } from './error.js';

const browser = typeof window !== 'undefined';

export { isSocketError, type SocketError } from './error.js';

/** Per-iterator queue so multiple `for await` consumers of one subscription each get values. */
type Consumer<T> = {
	push(value: T): void;
	/** With `error`, the iterator throws it instead of finishing: the stream failed. */
	end(error?: unknown): void;
};

type SharedSubscription = {
	readonly id: string;
	readonly signature: string;
	readonly current: unknown;
	readonly error: Issue[] | undefined;
	/** Resume point of the last value received, for re-subscribing after a reconnect. */
	readonly cursor: unknown;
	/**
	 * `true` once `end()` has run — either the server completed this subscription for good,
	 * or the last local owner released it. Either way, this object is abandoned: `acquire()`
	 * has already dropped it from the lookup map, so nothing more will ever arrive on it and
	 * a later `acquire()` for the same signature gets a fresh object instead.
	 */
	readonly terminal: boolean;
	incRef(): number;
	decRef(): number;
	streamMessage(): ClientMessage;
	push(value: unknown, at?: unknown): void;
	fail(errors: Issue[]): void;
	end(): void;
	iterate(): AsyncIterableIterator<unknown>;
};

/**
 * One server subscription, shared by every handle with the same module/export/args. Holds
 * the reactive `current`/`error` and fans values out to any imperative iterators.
 */
function createSharedSubscription(
	id: string,
	signature: string,
	module: string,
	exp: string,
	payload: unknown
): SharedSubscription {
	let current = $state<unknown>(undefined);
	let error = $state<Issue[] | undefined>(undefined);
	let cursor: unknown;
	let refCount = 0;
	let terminal = false;
	const consumers = new SvelteSet<Consumer<unknown>>();

	function push(value: unknown, at?: unknown): void {
		current = value;
		error = undefined;
		if (at !== undefined) cursor = at;
		for (const c of consumers) c.push(value);
	}

	function iterate(): AsyncIterableIterator<unknown> {
		const queue: unknown[] = [];
		let pending: { resolve(r: IteratorResult<unknown>): void; reject(e: unknown): void } | null =
			null;
		let ended = false;
		let failure: unknown;

		const consumer: Consumer<unknown> = {
			push: (value) => {
				if (pending) {
					pending.resolve({ value, done: false });
					pending = null;
				} else {
					// keep only the latest pending value — live streams are not event logs
					queue.length = 0;
					queue.push(value);
				}
			},
			end: (error) => {
				ended = true;
				failure = error;
				if (pending) {
					if (error === undefined) pending.resolve({ value: undefined, done: true });
					else pending.reject(error);
					failure = undefined;
					pending = null;
				}
			}
		};
		consumers.add(consumer);
		if (current !== undefined) queue.push(current);

		const iterator: AsyncIterableIterator<unknown> = {
			next: () => {
				if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
				if (failure !== undefined) {
					const error = failure;
					failure = undefined;
					return Promise.reject(error);
				}
				if (ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve, reject) => (pending = { resolve, reject }));
			},
			return: () => {
				consumers.delete(consumer);
				ended = true;
				failure = undefined;
				// a `next()` still waiting would otherwise never settle
				pending?.resolve({ value: undefined, done: true });
				pending = null;
				return Promise.resolve({ value: undefined, done: true });
			},
			[Symbol.asyncIterator]() {
				return iterator;
			}
		};
		return iterator;
	}

	return {
		id,
		signature,
		get current() {
			return current;
		},
		get error() {
			return error;
		},
		get cursor() {
			return cursor;
		},
		get terminal() {
			return terminal;
		},
		incRef: () => ++refCount,
		decRef: () => --refCount,
		streamMessage: () => ({
			type: 'stream',
			id,
			module,
			export: exp,
			payload,
			// only set after a reconnect, and only for streams that declare a cursor —
			// the handler replays from here to cover the gap
			...(cursor === undefined ? {} : { since: cursor })
		}),
		push,
		fail: (errors) => (error = errors),
		end: () => {
			terminal = true;
			// a server `error` came right before the `complete`: iterators throw it
			const failure = error ? fromIssues(error) : undefined;
			for (const c of consumers) c.end(failure);
			consumers.clear();
		},
		iterate
	};
}

const BACKOFF_BASE = 250;
const BACKOFF_MAX = 10_000;

type EventSocket = {
	readonly connected: boolean;
	readonly status: ConnectionStatus;
	acquire(module: string, exp: string, payload: unknown): SharedSubscription;
	release(sub: SharedSubscription): void;
	mutate(module: string, exp: string, payload: unknown): Promise<unknown>;
	reconnect(): void;
};

/** The single multiplexed WebSocket for the whole app. */
function createEventSocket(): EventSocket {
	let ws: WebSocket | null = null;
	let ready = false;
	let attempts = 0;
	let counter = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let lastPong = 0;

	const outbox: ClientMessage[] = [];
	const subs = new SvelteMap<string, SharedSubscription>();
	const subsById = new SvelteMap<string, SharedSubscription>();
	const mutations = new SvelteMap<
		string,
		{ resolve: (v: unknown) => void; reject: (e: unknown) => void }
	>();

	let status = $state<ConnectionStatus>('closed');
	// `open` once, then any later connect is a retry — so the UI can say "reconnecting…"
	let everConnected = false;

	function url(): string {
		// Same origin in both dev and prod: the Vite plugin serves the endpoint on the dev
		// server; the adapter serves it on the Bun server.
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.host}${ENDPOINT_PATH}`;
	}

	function raw(msg: ClientMessage): void {
		ws?.send(JSON.stringify(msg));
	}

	function sendOrQueue(msg: ClientMessage): void {
		if (ready) raw(msg);
		else outbox.push(msg);
	}

	function receive(data: string | ArrayBuffer): void {
		const msg = parseMessage<ServerMessage>(data);
		if (!msg) return;

		switch (msg.type) {
			case 'connection_ack':
				ready = true;
				attempts = 0;
				status = 'open';
				everConnected = true;
				startKeepalive();
				for (const sub of subs.values()) raw(sub.streamMessage());
				for (const queued of outbox.splice(0)) raw(queued);
				break;
			case 'ping':
				raw({ type: 'pong' });
				break;
			case 'pong':
				lastPong = Date.now();
				break;
			case 'next':
				subsById.get(msg.id)?.push(msg.payload, msg.cursor);
				break;
			case 'complete': {
				// The server ended this subscription for good. Forget it, or the next reconnect
				// would re-subscribe and a finite stream would replay from the start.
				const done = subsById.get(msg.id);
				if (done) {
					subs.delete(done.signature);
					subsById.delete(msg.id);
					done.end();
				}
				break;
			}
			case 'error': {
				const mut = mutations.get(msg.id);
				if (mut) {
					mut.reject(fromIssues(msg.errors));
					mutations.delete(msg.id);
				} else {
					subsById.get(msg.id)?.fail(msg.errors);
				}
				break;
			}
			case 'result': {
				mutations.get(msg.id)?.resolve(msg.payload);
				mutations.delete(msg.id);
				break;
			}
		}
	}

	function open(): void {
		status = everConnected ? 'reconnecting' : 'connecting';
		const socket = new WebSocket(url());
		ws = socket;
		// `close` events arrive asynchronously — after a `reconnect()` the old socket's
		// `onclose` must not clobber the freshly-opened connection, so every handler checks
		// it still belongs to the current socket.
		socket.onopen = () => {
			if (ws === socket) raw({ type: 'connection_init' });
		};
		socket.onmessage = (e) => {
			if (ws === socket) receive(e.data);
		};
		socket.onclose = () => {
			if (ws === socket) handleClose();
		};
		socket.onerror = () => socket.close();
	}

	/**
	 * Client-side keepalive. The server pings us to notice dead clients; we ping the server
	 * to notice dead *paths* — a half-open connection (sleep, NAT timeout, flaky mobile
	 * network) never fires `close`, so without this the app would sit there looking connected
	 * while receiving nothing.
	 */
	function startKeepalive(): void {
		stopKeepalive();
		lastPong = Date.now();
		pingTimer = setInterval(() => {
			if (Date.now() - lastPong > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
				reconnect(); // the socket looks alive but nothing is coming back
				return;
			}
			raw({ type: 'ping' });
		}, PING_INTERVAL_MS);
	}

	function stopKeepalive(): void {
		if (pingTimer) clearInterval(pingTimer);
		pingTimer = null;
	}

	/**
	 * A mutation that never got its `result` would hang forever, so a lost connection has to
	 * reject it. The server may still have applied it — mutations are at-most-once from the
	 * client's point of view, and retrying is the caller's decision.
	 */
	function failPendingMutations(): void {
		if (mutations.size === 0) return;
		const error = fromIssues([{ message: 'Connection lost before the server answered' }]);
		for (const pending of mutations.values()) pending.reject(error);
		mutations.clear();
		// drop queued frames whose promises we just rejected
		for (let i = outbox.length - 1; i >= 0; i--) {
			if (outbox[i].type === 'mutate') outbox.splice(i, 1);
		}
	}

	/** Everything that must happen when the connection stops being usable. */
	function teardown(): void {
		stopKeepalive();
		ready = false;
		// with nothing subscribed there is nothing to reconnect for, until something asks
		status = subs.size > 0 ? 'reconnecting' : 'closed';
		failPendingMutations();
	}

	function handleClose(): void {
		ws = null;
		teardown();
		scheduleReconnect();
	}

	function scheduleReconnect(): void {
		if (reconnectTimer || subs.size === 0) return;
		// jittered to 50–100% of the step, so the clients of a restarted server don't all
		// reconnect on the same tick
		const step = Math.min(BACKOFF_BASE * 2 ** attempts++, BACKOFF_MAX);
		const delay = step / 2 + Math.random() * (step / 2);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (!ws) open();
		}, delay);
	}

	const onOnline = () => {
		if (!ready) reconnect();
	};

	function ensure(): void {
		if (!browser || ws) return;
		open();
		window.addEventListener('online', onOnline);
	}

	function reconnect(): void {
		attempts = 0;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		const previous = ws;
		ws = null; // so the old socket's `close` event is ignored by the identity guard
		teardown();
		previous?.close();
		ensure();
	}

	function acquire(module: string, exp: string, payload: unknown): SharedSubscription {
		const signature = `${module}#${exp}:${stableStringify(payload)}`;
		let sub = subs.get(signature);
		if (!sub) {
			sub = createSharedSubscription(`s${counter++}`, signature, module, exp, payload);
			subs.set(signature, sub);
			subsById.set(sub.id, sub);
			ensure();
			if (ready) raw(sub.streamMessage());
		}
		sub.incRef();
		return sub;
	}

	function release(sub: SharedSubscription): void {
		if (sub.decRef() > 0) return;
		// only clear the slot if it's still this exact subscription — a server `complete`
		// (or another release) may have already dropped it and let a same-signature
		// `acquire()` install a new one, which this call must not evict
		if (subs.get(sub.signature) === sub) subs.delete(sub.signature);
		if (subsById.get(sub.id) === sub) subsById.delete(sub.id);
		sub.end();
		if (ready) raw({ type: 'complete', id: sub.id });
		// the last subscriber left during a backoff: there's nothing to reconnect for
		if (subs.size === 0 && reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
			status = 'closed';
		}
	}

	function mutate(module: string, exp: string, payload: unknown): Promise<unknown> {
		ensure();
		const id = `m${counter++}`;
		return new Promise((resolve, reject) => {
			mutations.set(id, { resolve, reject });
			sendOrQueue({ type: 'mutate', id, module, export: exp, payload });
		});
	}

	return {
		get connected() {
			return status === 'open';
		},
		get status() {
			return status;
		},
		acquire,
		release,
		mutate,
		reconnect
	};
}

/**
 * Deterministic stringify so `{a,b}` and `{b,a}` share a subscription. Applies `toJSON`
 * first, exactly as `JSON.stringify` itself would — without this, two arguments a real
 * `JSON.stringify` would tell apart (two different `Date`s, say, which have no *own*
 * enumerable properties for `Object.keys` to see) collapse into the same signature, and the
 * second subscriber silently gets the first one's data instead of what it asked for.
 */
function stableStringify(value: unknown): string {
	// `undefined` goes over the wire as no payload at all, which a schema can tell from `null`
	return encode(value, new Set()) ?? 'undefined';
}

/**
 * `JSON.stringify` with sorted keys, down to what it drops: `undefined` for a value it would
 * leave out (`undefined`, a function, a symbol), so `{ a: undefined }` signs like `{}` — the
 * same thing the server receives — and not like `{ a: null }`. A cycle throws, as it would.
 */
function encode(value: unknown, ancestors: Set<object>): string | undefined {
	if (value && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		value = (value as { toJSON(): unknown }).toJSON();
	}
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => encode(item, ancestors) ?? 'null').join(',')}]`;
		}
		const obj = value as Record<string, unknown>;
		const entries = Object.keys(obj)
			.sort()
			.flatMap((key) => {
				const encoded = encode(obj[key], ancestors);
				return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
			});
		return `{${entries.join(',')}}`;
	} finally {
		ancestors.delete(value);
	}
}

let socket: EventSocket | undefined;
function getSocket(): EventSocket {
	return (socket ??= createEventSocket());
}

const inertStream: Stream<never> = {
	get current() {
		return undefined;
	},
	get error() {
		return undefined;
	},
	get connected() {
		return false;
	},
	get status(): ConnectionStatus {
		return 'closed';
	},
	reconnect() {},
	async *[Symbol.asyncIterator]() {}
};

/**
 * Factory for the client stub of a `stream` export. The Vite plugin emits
 * `export const messages = createStream('<module>', 'messages')`.
 */
export function createStream<Args, T>(module: string, exp: string): StreamFn<Args, T> {
	return ((args: Args) => {
		// On the server (SSR) there is no socket; return an inert handle.
		if (!browser) return inertStream as Stream<T>;

		const sock = getSocket();
		const shared = sock.acquire(module, exp, args);

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			sock.release(shared);
		};

		// Who owns this handle's subscription? A component does, and gives it up when it is
		// destroyed. Outside one — a `for await` in a module, a test — nothing would ever let
		// go, so the iterators take over (see below).
		let ownedByComponent = false;
		try {
			onDestroy(release);
			ownedByComponent = true;
		} catch {
			// not in a component
		}

		return {
			get current() {
				return shared.current as T | undefined;
			},
			get error() {
				return shared.error;
			},
			get connected() {
				return sock.connected;
			},
			get status() {
				return sock.status;
			},
			reconnect() {
				sock.reconnect();
			},
			[Symbol.asyncIterator]() {
				// The subscription this handle was acquired for is over — `acquire()` already
				// dropped it from the lookup map, so `shared.iterate()` would hand back an
				// iterator nothing will ever push to again. Ending it immediately (rather than
				// quietly re-subscribing behind the caller's back) is what lets `for await`
				// finish instead of hanging, and is honest about what actually happened.
				if (shared.terminal) return (async function* () {})();

				const iterator = shared.iterate() as AsyncIterableIterator<T>;
				// Inside a component the component's lifetime governs: breaking out of one
				// `for await` must not cancel a subscription the template still renders.
				if (ownedByComponent) return iterator;

				// Standalone: this iterator holds its own reference, so several concurrent
				// loops are safe, and the last one to finish drops the subscription. Leaving
				// the loop (`break`, `throw`, or the stream ending) is what calls `return()`.
				const own = sock.acquire(module, exp, args);
				const finish = iterator.return!.bind(iterator);
				let returned = false;
				iterator.return = async (value?: unknown) => {
					const result = await finish(value);
					// a second `return()` must not release a reference someone else now holds
					if (!returned) {
						returned = true;
						sock.release(own);
						release();
					}
					return result as IteratorResult<T>;
				};
				return iterator;
			}
		};
	}) as StreamFn<Args, T>;
}

/**
 * Factory for the client stub of a `mutate` export. The Vite plugin emits
 * `export const send = createMutate('<module>', 'send')`.
 */
export function createMutate<Args, R>(module: string, exp: string): MutateFn<Args, R> {
	return ((args: Args) => {
		if (!browser) return Promise.reject(new Error('Mutations can only run in the browser'));
		return getSocket().mutate(module, exp, args) as Promise<R>;
	}) as MutateFn<Args, R>;
}
