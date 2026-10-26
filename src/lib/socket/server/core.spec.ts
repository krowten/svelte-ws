import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
	createInMemoryPubSub,
	getPubSub,
	setPubSub,
	publish,
	subscribe as busSubscribe,
	configureDefaultPubSub
} from '../pubsub.js';
import { createSocketConnection, type ConnectionSocket } from './connection.js';
import { stream, mutate } from './define.js';
import { createResolver } from './registry.js';
import { validate, isValidationError, socketError } from './validate.js';
import type { AnyDescriptor } from '../types.js';
import { parseMessage, type ServerMessage } from '../protocol.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

// each test gets a fresh global engine
beforeEach(() => setPubSub(createInMemoryPubSub()));

describe('bus / createInMemoryPubSub', () => {
	it('delivers published payloads to subscribers in order', async () => {
		const engine = createInMemoryPubSub();
		const it = engine.subscribe<number>('c');
		engine.publish('c', 1);
		engine.publish('c', 2);
		expect((await it.next()).value).toBe(1);
		expect((await it.next()).value).toBe(2);
	});

	it('isolates channels', async () => {
		const engine = createInMemoryPubSub();
		const a = engine.subscribe<number>('a');
		engine.publish('b', 99);
		engine.publish('a', 1);
		expect((await a.next()).value).toBe(1);
	});

	it('reclaims a channel once its last subscriber returns', async () => {
		const engine = createInMemoryPubSub();
		const a = engine.subscribe('c');
		const b = engine.subscribe('c');
		await a.return!();
		await b.return!();
		expect(() => engine.publish('c', 1)).not.toThrow();
	});

	it('module-level publish/subscribe use the active engine', async () => {
		const it = busSubscribe<number>('c');
		publish('c', 7);
		expect((await it.next()).value).toBe(7);
	});

	it('setPubSub swaps the active engine', () => {
		const custom = createInMemoryPubSub();
		setPubSub(custom);
		expect(getPubSub()).toBe(custom);
	});
});

describe('bounded subscriber queues', () => {
	it('drops the oldest values once a subscriber falls too far behind', async () => {
		const engine = createInMemoryPubSub({ maxQueuedMessages: 3 });
		const slow = engine.subscribe<number>('c');
		for (let i = 1; i <= 10; i++) engine.publish('c', i);

		// only the newest 3 survive — a live stream beats a backlog nobody read
		expect((await slow.next()).value).toBe(8);
		expect((await slow.next()).value).toBe(9);
		expect((await slow.next()).value).toBe(10);
	});

	it('does not drop anything for a consumer that keeps up', async () => {
		const engine = createInMemoryPubSub({ maxQueuedMessages: 2 });
		const fast = engine.subscribe<number>('c');
		engine.publish('c', 1);
		expect((await fast.next()).value).toBe(1);
		engine.publish('c', 2);
		expect((await fast.next()).value).toBe(2);
	});
});

describe('subscribe({ signal })', () => {
	it('ends a pending subscription immediately on abort, even on an idle channel', async () => {
		const engine = createInMemoryPubSub();
		const ac = new AbortController();

		let cleanedUp = false;
		async function* handler() {
			try {
				yield* engine.subscribe('idle', { signal: ac.signal });
			} finally {
				cleanedUp = true;
			}
		}

		const gen = handler();
		void gen.next(); // suspends inside `yield*`, waiting on a channel nobody publishes to

		ac.abort();
		// an async generator's own `.return()` would queue behind that pending `next()`
		// forever on an idle channel — `signal` must settle it directly instead
		await Promise.race([
			gen.return(undefined),
			new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out')), 200))
		]);
		expect(cleanedUp).toBe(true);
	});

	it('drops the subscriber from the channel once aborted, not just the local iterator', async () => {
		const engine = createInMemoryPubSub();
		const ac = new AbortController();
		const sub = engine.subscribe('c', { signal: ac.signal });

		ac.abort();
		await new Promise((r) => setTimeout(r, 0));

		// publishing after the only subscriber left must not throw or hang
		expect(() => engine.publish('c', 1)).not.toThrow();
		expect((await sub.next()).done).toBe(true);
	});
});

describe('subscribe() inside a stream', () => {
	it('ends with an already-aborted signal instead of waiting forever', async () => {
		const engine = createInMemoryPubSub();
		const ac = new AbortController();
		ac.abort();
		const sub = engine.subscribe('c', { signal: ac.signal });
		expect((await sub.next()).done).toBe(true);
	});

	it('ends with the stream without being handed ctx.signal', async () => {
		let running = 0;
		const feed = stream(async function* () {
			running++;
			try {
				yield* busSubscribe('idle'); // no signal: the stream's own one applies
			} finally {
				running--;
			}
		}) as unknown as AnyDescriptor;
		const { conn } = await harness({ 'm.socket.ts': { feed } });
		const open = (id: string) =>
			conn.handleMessage(
				JSON.stringify({ type: 'stream', id, module: 'm.socket.ts', export: 'feed', payload: null })
			);

		await open('1');
		await tick();
		expect(running).toBe(1);

		await conn.handleMessage(JSON.stringify({ type: 'complete', id: '1' }));
		await tick();
		expect(running).toBe(0);

		// and the slot is free again: the same id starts a fresh stream
		await open('1');
		await tick();
		expect(running).toBe(1);
		conn.dispose();
	});

	it('closes the connection with 4409 when an operation id still in use comes again', async () => {
		let running = 0;
		const feed = stream(async function* () {
			running++;
			try {
				yield* busSubscribe('quiet');
			} finally {
				running--;
			}
		}) as unknown as AnyDescriptor;
		const sent: ServerMessage[] = [];
		const closes: Array<number | undefined> = [];
		const conn = createSocketConnection({
			socket: { send: (data) => sent.push(JSON.parse(data)), close: (code) => closes.push(code) },
			request: new Request('http://localhost/_events'),
			resolve: () => feed
		});
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		const open = () =>
			conn.handleMessage(
				JSON.stringify({ type: 'stream', id: 'dup', module: 'm', export: 'feed', payload: null })
			);
		await open();
		await tick();
		await open();
		await tick();

		expect(closes).toEqual([4409]);
		// nothing answered under the reused id, and the original operation was cancelled
		expect(sent.filter((m) => 'id' in m)).toEqual([]);
		expect(running).toBe(0);
	});

	it('frees the slot of a handler stuck on something that never settles', async () => {
		const stuck = stream(async function* () {
			await new Promise(() => {});
			yield 1;
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ 'm.socket.ts': { stuck } });
		const open = () =>
			conn.handleMessage(
				JSON.stringify({
					type: 'stream',
					id: 'x',
					module: 'm.socket.ts',
					export: 'stuck',
					payload: null
				})
			);
		await open();
		await tick(); // let the handler start and get stuck
		await conn.handleMessage(JSON.stringify({ type: 'complete', id: 'x' }));
		await tick();
		await open();
		await tick();
		expect(sent.filter((m) => m.type === 'error')).toEqual([]);
		conn.dispose();
	});

	it('runs the handler cleanup when a value cannot be sent', async () => {
		let cleanedUp = false;
		const bad = stream(async function* () {
			try {
				yield 1n; // a BigInt: JSON can't encode it
				yield 2;
			} finally {
				cleanedUp = true;
			}
		}) as unknown as AnyDescriptor;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { conn } = await harness({ 'm.socket.ts': { bad } });
		await conn.handleMessage(
			JSON.stringify({
				type: 'stream',
				id: 'b',
				module: 'm.socket.ts',
				export: 'bad',
				payload: null
			})
		);
		await tick();
		expect(cleanedUp).toBe(true);
		errors.mockRestore();
	});

	it('logs an unexpected handler error when there is no handleError hook', async () => {
		const crash = mutate(() => {
			throw new Error('kaboom');
		}) as unknown as AnyDescriptor;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { conn, sent } = await harness({ 'm.socket.ts': { crash } });
		await conn.handleMessage(
			JSON.stringify({
				type: 'mutate',
				id: 'c',
				module: 'm.socket.ts',
				export: 'crash',
				payload: null
			})
		);
		await tick();
		expect(sent).toEqual([{ type: 'error', id: 'c', errors: [{ message: 'Internal Error' }] }]);
		expect(String(errors.mock.calls[0]?.[0])).toContain('mutate m.socket.ts#crash');
		errors.mockRestore();
	});
});

describe('configureDefaultPubSub', () => {
	// `holder()` treats the engine as "default" until `setPubSub` runs — the file-level
	// `beforeEach` above already calls it, so these tests reset the same well-known slot
	// `pubsub.ts` uses, putting it back to an untouched default the way a fresh process
	// would start.
	const SLOT = Symbol.for('svelte-ws.pubsub');
	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[SLOT];
	});

	it('sizes the default engine and never overrides a custom one', async () => {
		configureDefaultPubSub(1);
		const sub = getPubSub().subscribe<number>('c');
		getPubSub().publish('c', 1);
		getPubSub().publish('c', 2); // dropped — the queue holds only 1
		expect((await sub.next()).value).toBe(2);

		const custom = createInMemoryPubSub();
		setPubSub(custom);
		configureDefaultPubSub(64); // must not replace what setPubSub just installed
		expect(getPubSub()).toBe(custom);
	});

	it('is a no-op without a configured limit', () => {
		const before = getPubSub();
		configureDefaultPubSub(undefined);
		expect(getPubSub()).toBe(before);
	});
});

describe('exposeErrors (dev mode)', () => {
	it('sends the real message when enabled, redacts when not', async () => {
		const boom = mutate(() => {
			throw new Error('table users has no column banana');
		}) as unknown as AnyDescriptor;

		for (const [exposeErrors, expected] of [
			[true, 'table users has no column banana'],
			[false, 'Internal Error']
		] as const) {
			const sent: ServerMessage[] = [];
			const conn = createSocketConnection({
				socket: { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
				request: new Request('http://localhost/_events'),
				resolve: () => boom,
				exposeErrors
			});
			await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
			sent.length = 0;
			await conn.handleMessage(
				JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'boom', payload: null })
			);
			await tick();
			expect(sent).toEqual([{ type: 'error', id: '1', errors: [{ message: expected }] }]);
		}
	});
});

describe('parseMessage', () => {
	const frame = JSON.stringify({ type: 'ping' });

	it('parses string, Uint8Array and ArrayBuffer frames', () => {
		const bytes = new TextEncoder().encode(frame);
		expect(parseMessage(frame)).toEqual({ type: 'ping' });
		expect(parseMessage(bytes)).toEqual({ type: 'ping' });
		expect(parseMessage(bytes.buffer)).toEqual({ type: 'ping' });
	});

	it('returns null for garbage', () => {
		expect(parseMessage('{oops')).toBeNull();
		expect(parseMessage('42')).toBeNull();
		expect(parseMessage(JSON.stringify({ type: 7 }))).toBeNull();
	});
});

describe('validate', () => {
	it('returns input unchanged when schema is null', async () => {
		await expect(validate(null, { a: 1 })).resolves.toEqual({ a: 1 });
	});

	it('parses valid input', async () => {
		await expect(validate(v.object({ n: v.number() }), { n: 1 })).resolves.toEqual({ n: 1 });
	});

	it('throws a ValidationError with issues on invalid input', async () => {
		const err = await validate(v.object({ n: v.number() }), { n: 'x' }).then(
			() => null,
			(e) => e
		);
		expect(isValidationError(err)).toBe(true);
		expect((err as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
	});
});

describe('createResolver', () => {
	it('resolves descriptors by module + export and caches modules', async () => {
		let loads = 0;
		const desc = stream(async function* () {}) as unknown as AnyDescriptor;
		const resolve = createResolver(async (id) => {
			loads++;
			return id === 'm' ? { onX: desc } : {};
		});
		expect(await resolve('m', 'onX')).toBe(desc);
		expect(await resolve('m', 'onX')).toBe(desc);
		expect(loads).toBe(1);
		expect(await resolve('m', 'missing')).toBeUndefined();
	});

	it('forgets a module whose load failed, so the next operation retries it', async () => {
		let loads = 0;
		const desc = stream(async function* () {}) as unknown as AnyDescriptor;
		const resolve = createResolver(async () => {
			if (++loads === 1) throw new Error('transient');
			return { onX: desc };
		});
		await expect(resolve('m', 'onX')).rejects.toThrow('transient');
		expect(await resolve('m', 'onX')).toBe(desc);
		expect(loads).toBe(2);
	});

	it('does not cache when cache:false', async () => {
		let loads = 0;
		const resolve = createResolver(
			async () => {
				loads++;
				return {};
			},
			{ cache: false }
		);
		await resolve('m', 'x');
		await resolve('m', 'x');
		expect(loads).toBe(2);
	});
});

describe('define', () => {
	it('builds stream/mutate descriptors with and without schema', () => {
		const a = stream(async function* () {}) as unknown as AnyDescriptor;
		const b = mutate(v.object({ n: v.number() }), () => 1) as unknown as AnyDescriptor;
		expect(a).toMatchObject({ kind: 'stream', schema: null });
		expect(b.kind).toBe('mutate');
		expect(b.schema).not.toBeNull();
	});

	it('throws at definition when the handler is missing', () => {
		const schema = v.object({ n: v.number() });
		// @ts-expect-error — no handler
		expect(() => stream(schema)).toThrow(TypeError);
		// @ts-expect-error — no handler
		expect(() => mutate(schema)).toThrow(TypeError);
	});

	it('builds a descriptor for a transforming schema', () => {
		const send = mutate(
			v.pipe(v.string(), v.transform(Number)),
			(n) => n
		) as unknown as AnyDescriptor;
		expect(send.kind).toBe('mutate');
	});
});

/**
 * Compile-time-only: proves the client stub for a transforming schema is typed on its
 * *input*, not its output (R17) — a real bug, since `Output<Schema>` made the generated
 * `send({...})` in a component reject valid calls and accept invalid ones. Declared but
 * never invoked: `svelte-check` still type-checks an unreachable function body, and calling
 * a socket descriptor as a function here would throw at runtime — that substitution is the
 * Vite plugin's job, not something this unit test can exercise.
 */
function _typeOnly_transformingSchemaUsesInputType(): void {
	const send = mutate(v.pipe(v.string(), v.transform(Number)), (n) => {
		const _handlerSeesOutput: number = n;
		return _handlerSeesOutput;
	});

	// @ts-expect-error — the client must supply the schema's input (a string), not a number
	send(1);
	void send('1'); // compiles: the client stub is typed on the input
}
void _typeOnly_transformingSchemaUsesInputType;

/**
 * Build a connection wired to an in-memory registry, capturing all sent messages. Sends the
 * `connection_init` handshake for the caller (every operation requires one — see
 * "rejects an operation before connection_init") and clears it out of `sent`, so callers can
 * assert on just the frames their own test produces.
 */
async function harness(descriptors: Record<string, Record<string, AnyDescriptor>>) {
	const sent: ServerMessage[] = [];
	const socket: ConnectionSocket = {
		send: (data) => sent.push(JSON.parse(data)),
		close: () => {}
	};
	const conn = createSocketConnection({
		socket,
		request: new Request('http://localhost/_events'),
		resolve: (module, name) => descriptors[module]?.[name]
	});
	await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
	sent.length = 0;
	return { conn, sent };
}

describe('createSocketConnection', () => {
	it('acks connection_init', async () => {
		const sent: ServerMessage[] = [];
		const conn = createSocketConnection({
			socket: { send: (data) => sent.push(JSON.parse(data)), close: () => {} },
			request: new Request('http://localhost/_events'),
			resolve: () => undefined
		});
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		expect(sent).toEqual([{ type: 'connection_ack' }]);
	});

	it('rejects an operation sent before connection_init, without starting it', async () => {
		let started = false;
		const send = mutate(() => {
			started = true;
			return 1;
		}) as unknown as AnyDescriptor;
		const sent: ServerMessage[] = [];
		const conn = createSocketConnection({
			socket: { send: (data) => sent.push(JSON.parse(data)), close: () => {} },
			request: new Request('http://localhost/_events'),
			resolve: () => send
		});

		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'send', payload: null })
		);
		await tick();

		expect(started).toBe(false);
		expect(sent).toEqual([
			{
				type: 'error',
				id: '1',
				errors: [{ message: 'Send connection_init before starting operations' }]
			}
		]);

		// the handshake unblocks it
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '2', module: 'm', export: 'send', payload: null })
		);
		await tick();
		expect(started).toBe(true);
	});

	it('answers ping with pong', async () => {
		const { conn, sent } = await harness({});
		await conn.handleMessage(JSON.stringify({ type: 'ping' }));
		expect(sent).toEqual([{ type: 'pong' }]);
	});

	it('runs a mutate and returns its result', async () => {
		const send = mutate(v.object({ n: v.number() }), ({ n }) => n * 2) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ 'm.socket.ts': { send } });
		await conn.handleMessage(
			JSON.stringify({
				type: 'mutate',
				id: '1',
				module: 'm.socket.ts',
				export: 'send',
				payload: { n: 21 }
			})
		);
		await tick();
		expect(sent).toEqual([{ type: 'result', id: '1', payload: 42 }]);
	});

	it('rejects invalid mutate args with an error', async () => {
		const send = mutate(v.object({ n: v.number() }), ({ n }) => n) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ 'm.socket.ts': { send } });
		await conn.handleMessage(
			JSON.stringify({
				type: 'mutate',
				id: '1',
				module: 'm.socket.ts',
				export: 'send',
				payload: { n: 'x' }
			})
		);
		await tick();
		expect(sent[0].type).toBe('error');
	});

	it('errors on an unknown operation', async () => {
		const { conn, sent } = await harness({});
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'nope.ts', export: 'x', payload: {} })
		);
		await tick();
		expect(sent[0].type).toBe('error');
	});

	it('rejects a stream with the wrong kind', async () => {
		const m = mutate(() => 1) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ 'x.ts': { m } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'x.ts', export: 'm', payload: {} })
		);
		await tick();
		expect(sent.map((s) => s.type)).toEqual(['error', 'complete']);
	});

	it('streams a bus channel and stops on client complete', async () => {
		const onMsg = stream(v.object({ room: v.string() }), async function* ({ room }) {
			yield* busSubscribe<{ text: string }>(`room:${room}`);
		}) as unknown as AnyDescriptor;
		const pub = mutate(v.object({ room: v.string(), text: v.string() }), ({ room, text }) =>
			publish(`room:${room}`, { text })
		) as unknown as AnyDescriptor;

		const { conn, sent } = await harness({ 'chat.socket.ts': { onMsg, pub } });

		await conn.handleMessage(
			JSON.stringify({
				type: 'stream',
				id: 's1',
				module: 'chat.socket.ts',
				export: 'onMsg',
				payload: { room: 'a' }
			})
		);
		await tick();

		await conn.handleMessage(
			JSON.stringify({
				type: 'mutate',
				id: 'm1',
				module: 'chat.socket.ts',
				export: 'pub',
				payload: { room: 'a', text: 'hi' }
			})
		);
		await tick();
		expect(sent).toContainEqual({ type: 'next', id: 's1', payload: { text: 'hi' } });

		await conn.handleMessage(JSON.stringify({ type: 'complete', id: 's1' }));
		await tick();
		const before = sent.length;
		await conn.handleMessage(
			JSON.stringify({
				type: 'mutate',
				id: 'm2',
				module: 'chat.socket.ts',
				export: 'pub',
				payload: { room: 'a', text: 'after' }
			})
		);
		await tick();
		expect(sent.slice(before).filter((m) => m.type === 'next')).toHaveLength(0);
	});

	it('exposes upgrade data and the request via ctx', async () => {
		let seen: { data: unknown; url: string } | undefined;
		const who = mutate((_args, ctx) => {
			seen = { data: ctx.data, url: ctx.request.url };
			return ctx.data.visitor;
		}) as unknown as AnyDescriptor;

		const sent: ServerMessage[] = [];
		const conn = createSocketConnection({
			socket: { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
			request: new Request('http://localhost/_events?x=1'),
			data: { visitor: 'v42' },
			resolve: () => who
		});
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		sent.length = 0;
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'who', payload: null })
		);
		await tick();
		expect(seen).toEqual({ data: { visitor: 'v42' }, url: 'http://localhost/_events?x=1' });
		expect(sent).toEqual([{ type: 'result', id: '1', payload: 'v42' }]);
	});

	it('defaults ctx.data to an empty object', async () => {
		const who = mutate((_args, ctx) => Object.keys(ctx.data).length) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { who } });
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'who', payload: null })
		);
		await tick();
		expect(sent).toEqual([{ type: 'result', id: '1', payload: 0 }]);
	});

	it('redacts an unexpected error and still completes the stream', async () => {
		// eslint-disable-next-line require-yield
		const bad = stream(async function* () {
			throw new Error('connect ECONNREFUSED postgres://user:hunter2@db:5432');
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { bad } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'm', export: 'bad', payload: null })
		);
		await tick();
		// the credentials must not reach the browser
		expect(sent).toEqual([
			{ type: 'error', id: 's1', errors: [{ message: 'Internal Error' }] },
			{ type: 'complete', id: 's1' }
		]);
	});

	it('passes deliberate errors through untouched', async () => {
		const full = mutate(() => {
			throw socketError('This room is full');
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { full } });
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'full', payload: null })
		);
		await tick();
		expect(sent).toEqual([{ type: 'error', id: '1', errors: [{ message: 'This room is full' }] }]);
	});

	it('hands the original error to handleError and can override what the client sees', async () => {
		const seen: { error: unknown; operation?: { export: string } }[] = [];
		const bad = mutate(() => {
			throw new Error('secret detail');
		}) as unknown as AnyDescriptor;

		const sent: ServerMessage[] = [];
		const conn = createSocketConnection({
			socket: { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
			request: new Request('http://localhost/_events'),
			resolve: () => bad,
			handleError: (error, ctx) => {
				seen.push({ error, operation: ctx.operation });
				return [{ message: 'Try again later' }];
			}
		});

		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		sent.length = 0;
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: '1', module: 'm', export: 'bad', payload: null })
		);
		await tick();

		// the hook sees everything…
		expect((seen[0].error as Error).message).toBe('secret detail');
		expect(seen[0].operation?.export).toBe('bad');
		// …the client only what the hook returned
		expect(sent).toEqual([{ type: 'error', id: '1', errors: [{ message: 'Try again later' }] }]);
	});

	it('caps concurrent operations per connection', async () => {
		// eslint-disable-next-line require-yield
		const forever = stream(async function* () {
			await new Promise(() => {}); // never yields, never ends
		}) as unknown as AnyDescriptor;

		const sent: ServerMessage[] = [];
		const conn = createSocketConnection({
			socket: { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
			request: new Request('http://localhost/_events'),
			resolve: () => forever,
			limits: { maxOperations: 2 }
		});

		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		for (const id of ['s1', 's2', 's3']) {
			void conn.handleMessage(
				JSON.stringify({ type: 'stream', id, module: 'm', export: 'forever', payload: null })
			);
		}
		await tick();

		const rejected = sent.filter((m) => m.type === 'error');
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ id: 's3' });
		expect((rejected[0] as { errors: { message: string }[] }).errors[0].message).toMatch(
			/Too many concurrent operations/
		);
	});

	it('closes the connection on an oversized frame', async () => {
		let closed: { code?: number; reason?: string } | undefined;
		const conn = createSocketConnection({
			socket: { send: () => {}, close: (code, reason) => (closed = { code, reason }) },
			request: new Request('http://localhost/_events'),
			resolve: () => undefined,
			limits: { maxPayloadBytes: 32 }
		});

		await conn.handleMessage(JSON.stringify({ type: 'ping', padding: 'x'.repeat(100) }));
		expect(closed).toEqual({ code: 1009, reason: 'message too large' });
	});

	it('measures a frame in UTF-8 bytes, not string length', async () => {
		let closed: { code?: number } | undefined;
		const conn = createSocketConnection({
			socket: { send: () => {}, close: (code) => (closed = { code }) },
			request: new Request('http://localhost/_events'),
			resolve: () => undefined,
			limits: { maxPayloadBytes: 64 }
		});

		// 50 characters, but 150 bytes on the wire
		const frame = JSON.stringify({ type: 'ping', p: '€'.repeat(40) });
		expect(frame.length).toBeLessThan(64);
		await conn.handleMessage(frame);
		expect(closed).toEqual({ code: 1009 });
	});

	it('ignores an overlong operation id, and rejects a malformed target', async () => {
		let started = false;
		const run = mutate(() => {
			started = true;
			return 1;
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { run } });

		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: 'x'.repeat(10_000), module: 'm', export: 'run' })
		);
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: 'm1', module: 42, export: 'run' })
		);
		await tick();

		expect(started).toBe(false);
		// the overlong id can't be answered at all; the bad target gets a reply
		expect(sent).toEqual([
			{ type: 'error', id: 'm1', errors: [{ message: 'Invalid operation target' }] }
		]);
	});

	it('pauses a stream while the socket is congested, and drops a client that never drains', async () => {
		const ticker = stream(async function* () {
			for (let i = 0; i < 100; i++) yield i;
		}) as unknown as AnyDescriptor;

		let buffered = 0;
		let closed: number | undefined;
		const conn = createSocketConnection({
			socket: {
				send: () => (buffered += 1000), // nothing ever drains
				close: (code) => (closed = code),
				get bufferedAmount() {
					return buffered;
				}
			},
			request: new Request('http://localhost/_events'),
			resolve: () => ticker,
			limits: { maxBufferedBytes: 2000, backpressureTimeoutMs: 0 }
		});

		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));
		void conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'm', export: 'ticker', payload: null })
		);
		await new Promise((resolve) => setTimeout(resolve, 150)); // outlast one drain poll

		expect(closed).toBe(1011); // gave up on a client that never reads
		expect(buffered).toBeLessThan(100 * 1000); // stopped well before the generator ended
	});

	/** A socket whose congestion the test sets by hand: nothing it sends ever drains. */
	function congestedConnection(
		descriptors: Record<string, AnyDescriptor>,
		limits: Parameters<typeof createSocketConnection>[0]['limits']
	) {
		const socket = {
			buffered: 0,
			sent: [] as ServerMessage[],
			closed: undefined as number | undefined
		};
		const conn = createSocketConnection({
			socket: {
				send: (d) => socket.sent.push(JSON.parse(d)),
				close: (code) => (socket.closed = code),
				get bufferedAmount() {
					return socket.buffered;
				}
			},
			request: new Request('http://localhost/_events'),
			resolve: (_module, name) => descriptors[name],
			limits
		});
		return { conn, socket };
	}

	it('holds a mutation result back while the socket is congested', async () => {
		const save = mutate(() => 'saved') as unknown as AnyDescriptor;
		const { conn, socket } = congestedConnection({ save }, { maxBufferedBytes: 2000 });
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));

		socket.buffered = 5000;
		await conn.handleMessage(
			JSON.stringify({ type: 'mutate', id: 'm1', module: 'm', export: 'save', payload: null })
		);
		await tick();
		expect(socket.sent.filter((m) => m.type === 'result')).toEqual([]);

		socket.buffered = 0;
		await new Promise((resolve) => setTimeout(resolve, 80)); // one drain poll
		expect(socket.sent.filter((m) => m.type === 'result')).toEqual([
			{ type: 'result', id: 'm1', payload: 'saved' }
		]);
		expect(socket.closed).toBeUndefined();
	});

	it('drops a client that keeps sending requests without reading the replies', async () => {
		const unknown = (id: string) =>
			JSON.stringify({ type: 'mutate', id, module: 'm', export: 'missing', payload: null });
		// `wait` only governs paused streams; the reply ceiling holds either way
		const { conn, socket } = congestedConnection(
			{},
			{ maxBufferedBytes: 2000, onBackpressure: 'wait' }
		);
		await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));

		// a client that reads keeps getting answers, however many it asks for
		for (let i = 0; i < 200; i++) await conn.handleMessage(unknown(`a${i}`));
		await tick();
		expect(socket.closed).toBeUndefined();
		expect(socket.sent.filter((m) => m.type === 'error')).toHaveLength(200);

		socket.buffered = 5000; // stops reading, keeps sending
		const before = socket.sent.length;
		for (let i = 0; i < 200; i++) await conn.handleMessage(unknown(`b${i}`));
		await tick();
		expect(socket.closed).toBe(1011);
		// about 2000 characters of replies went out, nowhere near all 200
		const extra = socket.sent.length - before;
		expect(extra).toBeGreaterThan(10);
		expect(extra).toBeLessThan(60);
	});

	it('completes when a finite stream ends', async () => {
		const finite = stream(async function* () {
			yield 1;
			yield 2;
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { finite } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'm', export: 'finite', payload: null })
		);
		await tick();
		expect(sent).toEqual([
			{ type: 'next', id: 's1', payload: 1 },
			{ type: 'next', id: 's1', payload: 2 },
			{ type: 'complete', id: 's1' }
		]);
	});

	it('ignores frames that are not valid messages', async () => {
		const { conn, sent } = await harness({});
		await conn.handleMessage('not json');
		await conn.handleMessage(JSON.stringify({ no: 'type' }));
		await conn.handleMessage(JSON.stringify(42));
		expect(sent).toEqual([]);
	});

	it('closes the socket when pongs stop coming (keepalive)', async () => {
		vi.useFakeTimers();
		try {
			const sent: ServerMessage[] = [];
			let closed: { code?: number } | undefined;
			const conn = createSocketConnection({
				socket: {
					send: (d) => sent.push(JSON.parse(d)),
					close: (code) => (closed = { code })
				},
				request: new Request('http://localhost/_events'),
				resolve: () => undefined,
				pingIntervalMs: 100,
				pongTimeoutMs: 50
			});
			await conn.handleMessage(JSON.stringify({ type: 'connection_init' }));

			await vi.advanceTimersByTimeAsync(100);
			expect(sent).toContainEqual({ type: 'ping' });
			// client answers once — connection stays alive
			await conn.handleMessage(JSON.stringify({ type: 'pong' }));
			await vi.advanceTimersByTimeAsync(100);
			expect(closed).toBeUndefined();

			// then goes silent — connection is dropped with the keepalive close code
			await vi.advanceTimersByTimeAsync(300);
			expect(closed).toEqual({ code: 4408 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('tags values with a cursor and hands `since` back to the handler on resubscribe', async () => {
		const seen: unknown[] = [];
		const feed = stream(
			async function* (_args, ctx) {
				seen.push(ctx.since);
				// a real handler would replay from `since`; here we just prove it arrives
				yield { id: 'a1' };
				yield { id: 'a2' };
			},
			{ cursor: (message: { id: string }) => message.id }
		) as unknown as AnyDescriptor;

		const { conn, sent } = await harness({ m: { feed } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'm', export: 'feed', payload: null })
		);
		await tick();

		expect(seen).toEqual([undefined]); // a fresh subscription resumes from nothing
		expect(sent.filter((message) => message.type === 'next')).toEqual([
			{ type: 'next', id: 's1', payload: { id: 'a1' }, cursor: 'a1' },
			{ type: 'next', id: 's1', payload: { id: 'a2' }, cursor: 'a2' }
		]);

		// what the client sends after a reconnect
		await conn.handleMessage(
			JSON.stringify({
				type: 'stream',
				id: 's2',
				module: 'm',
				export: 'feed',
				payload: null,
				since: 'a2'
			})
		);
		await tick();
		expect(seen).toEqual([undefined, 'a2']);
	});

	it('does not hand a client-sent `since` to a stream without a cursor', async () => {
		const seen: unknown[] = [];
		const plain = stream(async function* (_args, ctx) {
			seen.push(ctx.since);
			yield 1;
		}) as unknown as AnyDescriptor;
		const { conn } = await harness({ m: { plain } });
		await conn.handleMessage(
			JSON.stringify({
				type: 'stream',
				id: 's1',
				module: 'm',
				export: 'plain',
				payload: null,
				since: 'forged'
			})
		);
		await tick();
		expect(seen).toEqual([undefined]);
	});

	it('leaves values untagged for streams without a cursor', async () => {
		const plain = stream(async function* () {
			yield 1;
		}) as unknown as AnyDescriptor;
		const { conn, sent } = await harness({ m: { plain } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'm', export: 'plain', payload: null })
		);
		await tick();
		expect(sent[0]).toEqual({ type: 'next', id: 's1', payload: 1, cursor: undefined });
	});

	it('aborts active streams on dispose', async () => {
		let aborted = false;
		const onMsg = stream(async function* (_args, ctx) {
			ctx.signal.addEventListener('abort', () => (aborted = true));
			yield* busSubscribe('c');
		}) as unknown as AnyDescriptor;
		const { conn } = await harness({ 'x.ts': { onMsg } });
		await conn.handleMessage(
			JSON.stringify({ type: 'stream', id: 's1', module: 'x.ts', export: 'onMsg', payload: {} })
		);
		await tick();
		conn.dispose();
		await tick();
		expect(aborted).toBe(true);
	});
});
