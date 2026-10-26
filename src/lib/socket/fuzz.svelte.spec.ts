/**
 * Fuzz test of the whole subscription lifecycle: the real client runtime, real components and
 * a real server connection, joined by an in-memory WebSocket the test can cut. Each run plays
 * a random sequence of what an app and its network do (mount and unmount subscribers, iterate
 * streams by hand, publish, call mutations, drop the connection, reconnect) and after every
 * step checks the client and the server against a small model of what has to be true.
 *
 * Replay a failure with the seed and run from its message:
 * FUZZ_SEED=<seed> bun run test:unit -- --run fuzz.svelte -t 'run <run> '
 *
 * The model:
 * - Handles with the same stream and arguments share one subscription ("instance"), alive
 *   while any component or iterator holds it. The server runs exactly one generator per live
 *   instance while connected, and none while disconnected.
 * - A live stream shows the last value published to its channel while the connection was
 *   open. Values published while disconnected are lost, except for the resumable stream: its
 *   cursor makes the server replay them after the reconnect.
 * - Finite streams end with their last value; the failing one shows its value and its error.
 * - A mutation resolves, or rejects with its error, unless the connection drops before the
 *   answer, in which case it rejects with "Connection lost". Calls made while disconnected
 *   wait for the next connection.
 * - Whenever a live subscription exists, the client comes back after a drop.
 */
import type { AnyDescriptor, Stream, StreamFn } from './types.js';
import type { ConnectionSocket, SocketConnection } from './server/connection.js';

import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import * as v from 'valibot';
import Subscriber from './test-fixtures/Subscriber.svelte';
import { createMutate, createStream, isSocketError } from './client.svelte.js';
import { createInMemoryPubSub } from './pubsub.js';
import { createSocketConnection } from './server/connection.js';
import { mutate, stream } from './server/define.js';
import { socketError } from './server/validate.js';

declare module 'vitest' {
	export interface ProvidedContext {
		fuzz: { seed: number; runs: number; steps: number };
	}
}

const { seed, runs, steps } = inject('fuzz');

/** The longest reconnect backoff step, plus a tick. */
const RECONNECT_MS = 10_001;
const LOST = 'Connection lost before the server answered';
const ACTIONS = [
	'mount',
	'iterate',
	'release',
	'publish',
	'publish offline',
	'send',
	'echo',
	'echo offline',
	'fail',
	'slow',
	'answer slow',
	'drop',
	'reconnect',
	'outage',
	'network back'
] as const;
const count = (action: (typeof ACTIONS)[number]) => tally.set(action, (tally.get(action) ?? 0) + 1);

/** mulberry32: tiny seeded PRNG, so a failing sequence can be replayed exactly. */
const mulberry32 = (a: number) => () => {
	a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const engine = createInMemoryPubSub();
const registry: Record<string, Record<string, AnyDescriptor>> = {};

/**
 * What the client runtime gets instead of a browser WebSocket: frames go straight into a
 * server connection and back, one microtask later, in order. `cut()` is the network going
 * away, as the server or a dead link would close it. During an `outage` every new connection
 * fails the way a browser's does: an `error`, then a `close`.
 */
class MemorySocket {
	static current: MemorySocket | null = null;
	static outage = false;

	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	closed = false;
	acked = false;
	conn: SocketConnection | undefined;

	constructor(public url: string) {
		MemorySocket.current = this;
		if (MemorySocket.outage) {
			this.closed = true;
			queueMicrotask(() => {
				this.onerror?.();
				this.onclose?.();
			});
			return;
		}
		const socket: ConnectionSocket = {
			send: (data) =>
				queueMicrotask(() => {
					if (this.closed) return;
					if ((JSON.parse(data) as { type: string }).type === 'connection_ack') this.acked = true;
					this.onmessage?.({ data });
				}),
			close: () => this.cut()
		};
		this.conn = createSocketConnection({
			socket,
			request: new Request('http://localhost/_events'),
			resolve: (module, name) => registry[module]?.[name]
		});
		queueMicrotask(() => this.onopen?.());
	}

	send(data: string): void {
		if (!this.closed) queueMicrotask(() => void this.conn?.handleMessage(data));
	}

	close(): void {
		this.cut();
	}

	cut(): void {
		if (this.closed) return;
		this.closed = true;
		this.conn?.dispose();
		queueMicrotask(() => this.onclose?.());
	}

	static get open(): boolean {
		return !!this.current && !this.current.closed && this.current.acked;
	}
}

vi.stubGlobal('WebSocket', MemorySocket);

/** How often each action ran across all runs; a kind that never ran means the fuzzer is blind. */
const tally = new Map<string, number>();

const problems: string[] = [];
const onRejection = (event: PromiseRejectionEvent) =>
	problems.push(`unhandled rejection: ${String(event.reason)}`);
const onError = (event: ErrorEvent) => problems.push(`uncaught error: ${event.message}`);

beforeAll(() => {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
	});
	window.addEventListener('unhandledrejection', onRejection);
	window.addEventListener('error', onError);
	vi.spyOn(console, 'error').mockImplementation((...args) =>
		problems.push(`console.error: ${args.join(' ')}`)
	);
});

afterAll(() => {
	if (runs >= 5) {
		for (const action of ACTIONS)
			expect(tally.get(action), `action "${action}" never ran`).toBeGreaterThan(0);
	}
	window.removeEventListener('unhandledrejection', onRejection);
	window.removeEventListener('error', onError);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Was the connection open after the previous step? A fresh `ack` is the model's reconnect. */
let wasOpen = false;

/**
 * Let every frame and handler that is due run to completion, and wait out the reconnect
 * backoff when the connection is down. Reports whether a new connection came up.
 */
async function settle(): Promise<boolean> {
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
	if (!MemorySocket.open) {
		await vi.advanceTimersByTimeAsync(RECONNECT_MS);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
	}
	const reconnected = MemorySocket.open && !wasOpen;
	wasOpen = MemorySocket.open;
	return reconnected;
}

type Live = 'feed' | 'resumable';
type Kind = Live | 'finite' | 'boom';
type Instance = { refs: number; current: number | undefined; cursor: number | undefined };
type Owner = {
	id: number;
	kind: Kind;
	args: { ch: string } | { n: number } | null;
	key: string | null;
	handle: Stream<unknown>;
	/** Whether a connection has been up since this owner subscribed, so the server has run it. */
	served: boolean;
} & (
	| { by: 'component'; component: ReturnType<typeof mount> }
	| {
			by: 'iterator';
			iterator: AsyncIterator<unknown>;
			values: unknown[];
			done: boolean;
			/** What the loop threw, if the stream failed. */
			failure?: unknown;
	  }
);
type Call = {
	id: number;
	kind: 'send' | 'echo' | 'fail' | 'slow';
	arg: unknown;
	lost: boolean;
	released: boolean;
	outcome?: { ok: true; value: unknown } | { ok: false; error: unknown };
};

for (let run = 0; run < runs; run++) {
	test(`fuzz run ${run} (seed ${seed})`, async () => {
		const rand = mulberry32(seed + run * 1_000_003);
		const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

		// ---- server side of this run ------------------------------------------------------
		const module = `run${run}.socket.ts`;
		const CHANNELS = [`r${run}:a`, `r${run}:b`];
		const history: Record<string, number[]> = Object.fromEntries(CHANNELS.map((c) => [c, []]));
		const generators = { live: 0 };
		const slow: Array<() => void> = [];
		let counter = 0;

		const publishValue = (ch: string, value: number) => {
			history[ch].push(value);
			void engine.publish(ch, value);
		};

		registry[module] = {
			feed: stream(v.object({ ch: v.string() }), async function* ({ ch }, ctx) {
				generators.live++;
				try {
					yield* engine.subscribe<number>(ch, { signal: ctx.signal });
				} finally {
					generators.live--;
				}
			}),
			resumable: stream(
				v.object({ ch: v.string() }),
				async function* ({ ch }, ctx) {
					generators.live++;
					try {
						const since = ctx.since as number | undefined;
						if (since !== undefined) yield* history[ch].filter((value) => value > since);
						yield* engine.subscribe<number>(ch, { signal: ctx.signal });
					} finally {
						generators.live--;
					}
				},
				{ cursor: (value: number) => value }
			),
			finite: stream(v.object({ n: v.number() }), async function* ({ n }) {
				for (let i = 0; i < n; i++) yield i;
			}),
			boom: stream(async function* () {
				yield 1;
				throw socketError('boom');
			}),
			send: mutate(v.object({ ch: v.string(), value: v.number() }), ({ ch, value }) => {
				publishValue(ch, value);
				return value;
			}),
			echo: mutate((args) => args),
			fail: mutate(() => {
				throw socketError('nope');
			}),
			slow: mutate(() => new Promise((resolve) => slow.push(() => resolve('slow'))))
		} as unknown as Record<string, AnyDescriptor>;

		const streams = Object.fromEntries(
			(['feed', 'resumable', 'finite', 'boom'] as const).map((kind) => [
				kind,
				createStream(module, kind) as StreamFn<unknown, unknown>
			])
		) as Record<Kind, StreamFn<unknown, unknown>>;
		const mutations = Object.fromEntries(
			(['send', 'echo', 'fail', 'slow'] as const).map((kind) => [kind, createMutate(module, kind)])
		) as Record<Call['kind'], (args: unknown) => Promise<unknown>>;

		// ---- model ------------------------------------------------------------------------
		const instances = new Map<string, Instance>();
		const owners: Owner[] = [];
		const calls: Call[] = [];
		let ownerIds = 0;

		const hold = (key: string) => {
			const instance = instances.get(key) ?? { refs: 0, current: undefined, cursor: undefined };
			instance.refs++;
			instances.set(key, instance);
		};
		const drop = (key: string) => {
			const instance = instances.get(key)!;
			if (--instance.refs === 0) instances.delete(key);
		};
		const deliver = (ch: string, value: number) => {
			for (const kind of ['feed', 'resumable'] as const) {
				const instance = instances.get(`${kind}:${ch}`);
				if (instance) instance.current = instance.cursor = value;
			}
		};
		const onReconnect = () => {
			for (const owner of owners) owner.served = true;
			for (const [key, instance] of instances) {
				if (!key.startsWith('resumable:') || instance.cursor === undefined) continue;
				const last = history[key.slice('resumable:'.length)].at(-1);
				if (last !== undefined && last > instance.cursor) instance.current = instance.cursor = last;
			}
		};
		const loseInFlight = () => {
			for (const call of calls) if (!call.outcome) call.lost = true;
		};

		const argsFor = (kind: Kind) =>
			kind === 'feed' || kind === 'resumable'
				? { ch: pick(CHANNELS) }
				: kind === 'finite'
					? { n: pick([1, 3]) }
					: null;
		const keyFor = (kind: Kind, args: Owner['args']) =>
			kind === 'feed' || kind === 'resumable' ? `${kind}:${(args as { ch: string }).ch}` : null;

		// ---- actions ----------------------------------------------------------------------
		const log: string[] = [];
		const KINDS: readonly Kind[] = ['feed', 'feed', 'resumable', 'resumable', 'finite', 'boom'];

		const mountOne = () => {
			const kind = pick(KINDS);
			const args = argsFor(kind);
			const key = keyFor(kind, args);
			let handle: Stream<unknown> | undefined;
			const component = mount(Subscriber, {
				target: document.body,
				props: { stream: streams[kind], args, onhandle: (h: Stream<unknown>) => (handle = h) }
			});
			if (key) hold(key);
			const owner = {
				id: ownerIds++,
				kind,
				args,
				key,
				handle: handle!,
				served: MemorySocket.open,
				by: 'component',
				component
			} as const;
			owners.push(owner);
			count('mount');
			log.push(`mount #${owner.id} ${kind} ${JSON.stringify(args)}`);
		};

		const iterateOne = () => {
			const kind = pick(KINDS);
			const args = argsFor(kind);
			const key = keyFor(kind, args);
			const handle = streams[kind](args);
			const iterator = handle[Symbol.asyncIterator]();
			if (key) hold(key);
			const owner: Owner = {
				id: ownerIds++,
				kind,
				args,
				key,
				handle,
				served: MemorySocket.open,
				by: 'iterator',
				iterator,
				values: [],
				done: false
			};
			owners.push(owner);
			void (async () => {
				for (;;) {
					let step: IteratorResult<unknown>;
					try {
						step = await iterator.next();
					} catch (error) {
						owner.failure = error;
						break;
					}
					if (step.done) break;
					owner.values.push(step.value);
				}
				owner.done = true;
			})();
			count('iterate');
			log.push(`iterate #${owner.id} ${kind} ${JSON.stringify(args)}`);
		};

		const release = async (owner: Owner) => {
			owners.splice(owners.indexOf(owner), 1);
			if (owner.by === 'component') void unmount(owner.component);
			else await owner.iterator.return?.();
			if (owner.key) drop(owner.key);
		};

		const call = (kind: Call['kind'], arg: unknown) => {
			// a call during an outage fails along with the connection attempt it starts
			const entry: Call = {
				id: calls.length,
				kind,
				arg,
				lost: MemorySocket.outage,
				released: false
			};
			calls.push(entry);
			mutations[kind](arg).then(
				(value) => (entry.outcome = { ok: true, value }),
				(error) => (entry.outcome = { ok: false, error })
			);
			count(kind === 'echo' && !MemorySocket.open ? 'echo offline' : kind);
			log.push(`mutate #${entry.id} ${kind} ${JSON.stringify(arg)}`);
		};

		const step = async () => {
			const open = MemorySocket.open;
			const options: Array<() => Promise<void> | void> = [mountOne, mountOne, iterateOne];
			if (owners.length) {
				options.push(async () => {
					const owner = pick(owners);
					count('release');
					log.push(`release #${owner.id} (${owner.by})`);
					await release(owner);
				});
			}
			options.push(() => {
				const ch = pick(CHANNELS);
				const value = ++counter;
				count(open ? 'publish' : 'publish offline');
				log.push(`publish ${ch} ${value}${open ? '' : ' (while disconnected)'}`);
				publishValue(ch, value);
				if (open) deliver(ch, value);
			});
			// `send` publishes from the server, so only while the model knows it will arrive
			if (open) {
				options.push(() => {
					const ch = pick(CHANNELS);
					const value = ++counter;
					call('send', { ch, value });
					deliver(ch, value);
				});
			}
			options.push(() => call('echo', { n: ++counter }));
			options.push(() => call('fail', null));
			options.push(() => call('slow', null));
			if (slow.length) {
				options.push(() => {
					count('answer slow');
					log.push(`answer ${slow.length} slow mutation(s)`);
					for (const resolve of slow.splice(0)) resolve();
					for (const entry of calls) if (entry.kind === 'slow') entry.released = true;
				});
			}
			if (open) {
				options.push(() => {
					count('drop');
					log.push('network drop');
					MemorySocket.current!.cut();
					loseInFlight();
					wasOpen = false;
				});
			}
			// a longer outage, so that several steps happen while every reconnect attempt fails
			if (!MemorySocket.outage) {
				options.push(() => {
					count('outage');
					log.push('outage begins');
					MemorySocket.outage = true;
					MemorySocket.current?.cut();
					loseInFlight();
					wasOpen = false;
				});
			} else {
				options.push(() => {
					count('network back');
					log.push('outage ends');
					MemorySocket.outage = false;
				});
			}
			if (owners.length) {
				options.push(() => {
					count('reconnect');
					log.push('handle.reconnect()');
					pick(owners).handle.reconnect();
					loseInFlight();
					wasOpen = false;
				});
			}

			await pick(options)();
			if (await settle()) onReconnect();
		};

		// ---- invariants -------------------------------------------------------------------
		const check = (n: number) => {
			const where = `seed ${seed}, run ${run}, step ${n}\n${log.join('\n')}`;
			const open = MemorySocket.open;

			expect(problems, `errors: ${where}`).toEqual([]);

			const liveKeys = [...instances.keys()];
			if (liveKeys.length && !MemorySocket.outage) {
				expect(open, `reconnects while subscribed: ${where}`).toBe(true);
			}
			expect(generators.live, `server generators: ${where}`).toBe(open ? liveKeys.length : 0);
			// nothing left to reconnect for: the client says it's closed rather than "reconnecting"
			const waiting = owners.some((owner) => owner.key || !owner.served);
			if (!open && !waiting && owners.length) {
				expect(owners[0].handle.status, `closed with nothing subscribed: ${where}`).toBe('closed');
			}

			for (const owner of owners) {
				const who = `#${owner.id} ${owner.kind} ${JSON.stringify(owner.args)}: ${where}`;
				expect(owner.handle.connected, `connected ${who}`).toBe(open);
				expect(owner.handle.status === 'open', `status ${who}`).toBe(open);

				if (owner.key) {
					const instance = instances.get(owner.key)!;
					expect(owner.handle.current, `current ${who}`).toBe(instance.current);
					expect(owner.handle.error, `error ${who}`).toBeUndefined();
					if (owner.by === 'iterator') {
						const values = owner.values as number[];
						expect(owner.done, `iterator still running ${who}`).toBe(false);
						expect(values, `iterator order ${who}`).toEqual([...values].sort((a, b) => a - b));
						if (instance.current !== undefined) {
							expect(values.at(-1), `iterator latest ${who}`).toBe(instance.current);
						}
					}
				} else if (!owner.served) {
					// still waiting for a connection: nothing can have arrived yet
					expect(owner.handle.current, `unserved ${who}`).toBeUndefined();
				} else if (owner.kind === 'finite') {
					const last = (owner.args as { n: number }).n - 1;
					if (owner.by === 'component') expect(owner.handle.current, `finite ${who}`).toBe(last);
					else {
						expect(owner.done, `finite iterator ends ${who}`).toBe(true);
						expect(owner.values.at(-1), `finite iterator ${who}`).toBe(last);
					}
				} else {
					if (owner.by === 'component') {
						expect(owner.handle.current, `boom value ${who}`).toBe(1);
						expect(owner.handle.error?.[0]?.message, `boom error ${who}`).toBe('boom');
					} else {
						expect(owner.done, `boom iterator ends ${who}`).toBe(true);
						expect(owner.values, `boom iterator ${who}`).toEqual([1]);
						const failure = owner.failure;
						expect(isSocketError(failure) && failure.message, `boom iterator throws ${who}`).toBe(
							'boom'
						);
					}
				}
			}

			for (const entry of calls) {
				const what = `mutation #${entry.id} ${entry.kind}: ${where}`;
				if (entry.lost) {
					expect(entry.outcome?.ok, `lost ${what}`).toBe(false);
					const error = (entry.outcome as { error: unknown } | undefined)?.error;
					expect(isSocketError(error) && error.message, `lost ${what}`).toBe(LOST);
				} else if (entry.kind === 'slow' && !entry.released) {
					expect(entry.outcome, `slow still pending ${what}`).toBeUndefined();
				} else if (entry.kind === 'fail') {
					const error = (entry.outcome as { error: unknown } | undefined)?.error;
					expect(isSocketError(error) && error.message, `fail ${what}`).toBe('nope');
				} else {
					const expected =
						entry.kind === 'slow'
							? 'slow'
							: entry.kind === 'send'
								? (entry.arg as { value: number }).value
								: entry.arg;
					expect(entry.outcome, `resolves ${what}`).toEqual({ ok: true, value: expected });
				}
			}
		};

		for (let n = 1; n <= steps; n++) {
			await step();
			check(n);
		}

		// everything let go: nothing may keep running on either side
		log.push('-- teardown --');
		MemorySocket.outage = false;
		for (const owner of [...owners]) await release(owner);
		for (const resolve of slow.splice(0)) resolve();
		for (const entry of calls) if (entry.kind === 'slow') entry.released = true;
		await settle();
		check(steps + 1);
		expect(generators.live, `leaked generators: seed ${seed}, run ${run}`).toBe(0);
		expect(
			calls.every((entry) => entry.outcome),
			`unsettled mutations: seed ${seed}, run ${run}`
		).toBe(true);
	});
}
