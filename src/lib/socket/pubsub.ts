/**
 * Standalone pub/sub bus — deliberately **not** coupled to the WebSocket layer.
 *
 * Import it directly inside any server code (a `stream`/`mutate` body, a native SvelteKit
 * `command`/`query.live`, a `+server.ts`, a webhook…) and publish/subscribe at will:
 *
 * ```ts
 * import { publish, subscribe } from 'svelte-ws/pubsub';
 *
 * // in a stream / query.live body
 * yield* subscribe(`room:${room}`);
 *
 * // in a mutate / command / +server body
 * publish(`room:${room}`, message);
 * ```
 *
 * Because every context shares one engine, a `stream` over WebSockets and a `query.live`
 * over SSE observe the same channels, and a ws `mutate` and an HTTP `command` both feed
 * them. The default engine is in-memory; swap it (e.g. Redis) with {@link setPubSub}.
 */
import { operationSignal } from './server/operation.js';

export type SubscribeOptions = {
	/**
	 * Ends the subscription the moment this fires, instead of only when the consumer stops
	 * iterating. Inside a `stream` handler `subscribe()` already uses the stream's own signal,
	 * so this is for everything else: a `query.live` body, a background job. Without one, an
	 * idle channel can keep the subscription forever, because an async generator's `.return()`
	 * gets queued behind a `yield*` delegate's still-pending `next()`; see "Ending a
	 * subscription" in the pub/sub docs.
	 */
	signal?: AbortSignal;
};

export type PubSubEngine = {
	publish(channel: string, payload: unknown): void | Promise<void>;
	subscribe<T = unknown>(channel: string, options?: SubscribeOptions): AsyncIterableIterator<T>;
};

type Pushable<T> = AsyncIterableIterator<T> & {
	push(value: T): void;
	end(): void;
};

/**
 * How many values a subscriber may fall behind before the oldest are dropped. A slow
 * consumer (a congested socket, a blocked handler) would otherwise grow the queue without
 * bound. Matches `limits.maxQueuedMessages`.
 */
const DEFAULT_QUEUE_LIMIT = 1024;

/** A FIFO async-iterable you can push into; `return()` runs `onReturn` for cleanup. */
function createPushable<T>(onReturn?: () => void, limit = DEFAULT_QUEUE_LIMIT): Pushable<T> {
	const queue: T[] = [];
	let pending: ((r: IteratorResult<T>) => void) | null = null;
	let ended = false;

	const done = (resolve: (r: IteratorResult<T>) => void) =>
		resolve({ value: undefined as never, done: true });

	const iterator: Pushable<T> = {
		push(value) {
			if (ended) return;
			if (pending) {
				pending({ value, done: false });
				pending = null;
			} else {
				queue.push(value);
				// keep the newest: a live stream is more useful than a backlog nobody read
				if (queue.length > limit) queue.shift();
			}
		},
		end() {
			if (ended) return;
			ended = true;
			if (pending) {
				done(pending);
				pending = null;
			}
		},
		next() {
			if (queue.length) return Promise.resolve({ value: queue.shift() as T, done: false });
			if (ended) return Promise.resolve({ value: undefined as never, done: true });
			return new Promise<IteratorResult<T>>((resolve) => (pending = resolve));
		},
		return() {
			if (!ended) {
				ended = true;
				onReturn?.();
			}
			if (pending) {
				done(pending);
				pending = null;
			}
			return Promise.resolve({ value: undefined as never, done: true });
		},
		[Symbol.asyncIterator]() {
			return iterator;
		}
	};

	return iterator;
}

/**
 * Default in-process engine. Each `subscribe()` gets its own FIFO queue (no events dropped
 * between yields); channels are reclaimed when their last subscriber leaves.
 */
export function createInMemoryPubSub(options: { maxQueuedMessages?: number } = {}): PubSubEngine {
	const channels = new Map<string, Set<Pushable<unknown>>>();

	return {
		publish(channel, payload) {
			const subscribers = channels.get(channel);
			if (!subscribers) return;
			for (const sub of subscribers) sub.push(payload);
		},

		subscribe<T = unknown>(
			channel: string,
			subscribeOptions?: SubscribeOptions
		): AsyncIterableIterator<T> {
			let subscribers = channels.get(channel);
			if (!subscribers) {
				subscribers = new Set();
				channels.set(channel, subscribers);
			}

			const pushable = createPushable<T>(() => {
				subscribers!.delete(pushable as Pushable<unknown>);
				if (subscribers!.size === 0) channels.delete(channel);
			}, options.maxQueuedMessages);
			subscribers.add(pushable as Pushable<unknown>);

			// The signal ends the subscription at once, a pending `next()` included. That is
			// the point of it: `yield* subscribe(channel)` delegates into this iterable, and the
			// outer generator's own `.return()` waits behind the delegate's unsettled `next()`,
			// so on an idle channel it would never run. A signal that is already aborted (the
			// stream was cancelled while its handler was still awaiting) ends it right away.
			const signal = subscribeOptions?.signal;
			if (signal?.aborted) void pushable.return?.();
			else signal?.addEventListener('abort', () => void pushable.return?.(), { once: true });
			return pushable;
		}
	};
}

// The active engine is pinned to globalThis so every module instance shares it. In dev the
// Vite plugin's `Bun.serve` and SvelteKit's SSR graph evaluate this module separately but in
// the same process/realm — without this they'd each get their own engine and a `command`
// could not reach a `stream`. In prod there's a single instance anyway.
const SLOT = Symbol.for('svelte-ws.pubsub');
type Holder = { engine: PubSubEngine; isDefault: boolean };
const globals = globalThis as unknown as Record<symbol, Holder | undefined>;

function holder(): Holder {
	return (globals[SLOT] ??= { engine: createInMemoryPubSub(), isDefault: true });
}

/** The active pub/sub engine. */
export function getPubSub(): PubSubEngine {
	return holder().engine;
}

/**
 * Replace the active engine. Call once at server start — e.g. in the `init` hook of
 * `src/hooks.server.ts`:
 * `setPubSub(createRedisPubSub(env.REDIS_URL))`.
 */
export function setPubSub(engine: PubSubEngine): void {
	const h = holder();
	h.engine = engine;
	h.isDefault = false;
}

/** Publish a payload to a channel on the active engine. */
export function publish(channel: string, payload: unknown): void | Promise<void> {
	return getPubSub().publish(channel, payload);
}

/**
 * Subscribe to a channel on the active engine; yields payloads until the iterator returns.
 * Inside a `stream` handler it ends with the stream, unless `options.signal` says otherwise.
 */
export function subscribe<T = unknown>(
	channel: string,
	options?: SubscribeOptions
): AsyncIterableIterator<T> {
	const signal = options?.signal ?? operationSignal();
	return getPubSub().subscribe<T>(channel, signal ? { ...options, signal } : options);
}

/**
 * Size the default in-memory engine's per-subscriber queue from `socket.config.ts`'s
 * `limits.maxQueuedMessages`. A no-op once a custom engine (Redis, …) is active — never
 * overrides something `setPubSub` already replaced. Called once by the runtime after
 * `init()` runs, so `setPubSub` inside `init` always wins.
 * @internal
 */
export function configureDefaultPubSub(maxQueuedMessages: number | undefined): void {
	if (maxQueuedMessages === undefined) return;
	const h = holder();
	if (h.isDefault) h.engine = createInMemoryPubSub({ maxQueuedMessages });
}
