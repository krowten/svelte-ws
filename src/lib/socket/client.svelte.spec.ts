import type { ClientMessage, ServerMessage, StreamMessage } from './protocol.js';

import { describe, expect, it, vi } from 'vitest';
import { createMutate, createStream, isSocketError } from './client.svelte.js';
import { PING_INTERVAL_MS, PONG_TIMEOUT_MS } from './protocol.js';

/**
 * Fake browser WebSocket capturing outgoing frames; tests drive the server side by calling
 * `receive`. Installed before the client runtime opens its lazily-created singleton socket.
 */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static get last(): FakeWebSocket {
		return this.instances[this.instances.length - 1];
	}

	sent: ClientMessage[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => this.onopen?.());
	}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	close() {
		queueMicrotask(() => this.onclose?.());
	}

	receive(msg: ServerMessage) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}

	/** Complete the connection handshake. */
	async ack() {
		await tick();
		this.receive({ type: 'connection_ack' });
	}
}

vi.stubGlobal('WebSocket', FakeWebSocket);

const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe('client runtime (single shared socket)', () => {
	it('opens one socket, handshakes, and delivers stream values reactively', async () => {
		const messages = createStream<{ room: string }, { text: string }>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'a' });

		const ws = FakeWebSocket.last;
		await ws.ack();

		expect(ws.sent[0]).toEqual({ type: 'connection_init' });
		const streamMsg = ws.sent.find((m) => m.type === 'stream')!;
		expect(streamMsg).toMatchObject({
			module: 'chat.socket.ts',
			export: 'messages',
			payload: { room: 'a' }
		});

		expect(feed.current).toBeUndefined();
		ws.receive({ type: 'next', id: streamMsg.id, payload: { text: 'hi' } });
		expect(feed.current).toEqual({ text: 'hi' });
		expect(feed.connected).toBe(true);
	});

	it('shares one server subscription between identical streams (argument order agnostic)', async () => {
		const messages = createStream<{ a: number; b: number }, number>('chat.socket.ts', 'messages');
		const ws = FakeWebSocket.last;
		const before = ws.sent.filter((m) => m.type === 'stream').length;

		messages({ a: 1, b: 2 });
		messages({ b: 2, a: 1 });
		await tick();

		expect(ws.sent.filter((m) => m.type === 'stream').length).toBe(before + 1);
	});

	it('supports for-await iteration over a stream', async () => {
		const numbers = createStream<{ seq: string }, number>('nums.socket.ts', 'numbers');
		const feed = numbers({ seq: 'x' });
		const ws = FakeWebSocket.last;
		await tick();
		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;

		const seen: number[] = [];
		const done = (async () => {
			for await (const n of feed) {
				seen.push(n);
				if (seen.length === 2) break;
			}
		})();
		await tick();
		ws.receive({ type: 'next', id: streamMsg.id, payload: 1 });
		await tick();
		ws.receive({ type: 'next', id: streamMsg.id, payload: 2 });
		await done;
		expect(seen).toEqual([1, 2]);
	});

	it('unsubscribes on the server when a standalone for-await ends', async () => {
		const numbers = createStream<{ seq: string }, number>('nums.socket.ts', 'leak-check');
		const feed = numbers({ seq: 'leak' });
		const ws = FakeWebSocket.last;
		await tick();

		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;

		const loop = (async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const value of feed) break;
		})();
		await tick();
		ws.receive({ type: 'next', id: streamMsg.id, payload: 1 });
		await loop;
		await tick();

		// the server is told to stop — without this the generator would run until the socket died
		expect(ws.sent).toContainEqual({ type: 'complete', id: streamMsg.id });
	});

	it('forgets a subscription the server completed, so it is not replayed on reconnect', async () => {
		const finite = createStream<{ n: number }, number>('nums.socket.ts', 'finite');
		const feed = finite({ n: 1 });
		const ws = FakeWebSocket.last;
		await ws.ack();

		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;
		ws.receive({ type: 'complete', id: streamMsg.id }); // the stream ended for good

		feed.reconnect();
		await tick();
		const fresh = FakeWebSocket.last;
		await fresh.ack();

		const replayed = fresh.sent.filter(
			(m) => m.type === 'stream' && JSON.stringify(m.payload) === JSON.stringify({ n: 1 })
		);
		expect(replayed).toHaveLength(0);
	});

	it('ends a standalone for-await on a completed stream instead of hanging or resubscribing', async () => {
		const finite = createStream<{ n: number }, number>('nums.socket.ts', 'finite-iter');
		const feed = finite({ n: 2 });
		const ws = FakeWebSocket.last;
		await ws.ack();

		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;
		ws.receive({ type: 'complete', id: streamMsg.id }); // the server ended it for good

		const before = ws.sent.filter((m) => m.type === 'stream').length;
		const seen: number[] = [];
		await Promise.race([
			(async () => {
				for await (const value of feed) seen.push(value);
			})(),
			new Promise((_r, reject) => setTimeout(() => reject(new Error('hung')), 200))
		]);

		expect(seen).toEqual([]);
		// no fresh subscription was opened behind the caller's back
		expect(ws.sent.filter((m) => m.type === 'stream').length).toBe(before);
	});

	it('gives Date arguments with different values distinct subscriptions', async () => {
		const atDate = createStream<{ at: Date }, string>('chat.socket.ts', 'sinceDate');
		const ws = FakeWebSocket.last;
		const before = ws.sent.filter((m) => m.type === 'stream').length;

		atDate({ at: new Date('2020-01-01') });
		atDate({ at: new Date('2021-06-15') });
		await tick();

		// `Object.keys(new Date(...))` is always empty — without accounting for `toJSON`,
		// both calls would collapse into one subscription and the second caller would
		// silently receive the first one's data
		expect(ws.sent.filter((m) => m.type === 'stream').length).toBe(before + 2);
	});

	it('keeps { a: undefined } and { a: null } apart, as the wire does', async () => {
		const feed = createStream<{ a?: null }, string>('chat.socket.ts', 'undefinedVsNull');
		const ws = FakeWebSocket.last;
		const before = ws.sent.filter((m) => m.type === 'stream').length;

		// `{ a: undefined }` goes out as `{}`, so it must not share `{ a: null }`'s subscription
		feed({ a: undefined });
		feed({ a: null });
		feed({});
		await tick();

		expect(ws.sent.filter((m) => m.type === 'stream').length).toBe(before + 2);
	});

	it('rejects a circular argument instead of recursing forever', () => {
		const feed = createStream<object, string>('chat.socket.ts', 'circular');
		const loop: Record<string, unknown> = {};
		loop.self = loop;
		expect(() => feed(loop)).toThrow(TypeError);
	});

	it('resolves a mutate with the result payload', async () => {
		const send = createMutate<{ text: string }, string>('chat.socket.ts', 'send');
		const promise = send({ text: 'hello' });
		const ws = FakeWebSocket.last;
		await tick();

		const mutateMsg = ws.sent.findLast((m) => m.type === 'mutate')!;
		expect(mutateMsg).toMatchObject({ module: 'chat.socket.ts', payload: { text: 'hello' } });
		ws.receive({ type: 'result', id: mutateMsg.id, payload: 'ok' });
		await expect(promise).resolves.toBe('ok');
	});

	it('rejects a mutate with a SocketError carrying issues', async () => {
		const send = createMutate<{ text: string }, string>('chat.socket.ts', 'send');
		const promise = send({ text: '' });
		const ws = FakeWebSocket.last;
		await tick();

		const mutateMsg = ws.sent.findLast((m) => m.type === 'mutate')!;
		ws.receive({ type: 'error', id: mutateMsg.id, errors: [{ message: 'too short' }] });
		const error = await promise.then(
			() => null,
			(e) => e
		);
		expect(isSocketError(error)).toBe(true);
		expect(error.issues).toEqual([{ message: 'too short' }]);
	});

	it('surfaces stream errors on the handle', async () => {
		const messages = createStream<{ room: string }, never>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'err-room' });
		const ws = FakeWebSocket.last;
		await tick();

		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;
		ws.receive({ type: 'error', id: streamMsg.id, errors: [{ message: 'denied' }] });
		expect(feed.error).toEqual([{ message: 'denied' }]);
	});

	it('clears a stream error once values flow again', async () => {
		const messages = createStream<{ room: string }, string>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'recovery-room' });
		const ws = FakeWebSocket.last;
		await tick();

		const streamMsg = ws.sent.findLast((m) => m.type === 'stream')!;
		ws.receive({ type: 'error', id: streamMsg.id, errors: [{ message: 'hiccup' }] });
		expect(feed.error).toEqual([{ message: 'hiccup' }]);

		// the stream recovers (e.g. after a resubscribe) — stale errors must not linger
		ws.receive({ type: 'next', id: streamMsg.id, payload: 'back' });
		expect(feed.error).toBeUndefined();
		expect(feed.current).toBe('back');
	});

	it('answers server pings with pongs', async () => {
		const ws = FakeWebSocket.last;
		const before = ws.sent.filter((m) => m.type === 'pong').length;
		ws.receive({ type: 'ping' });
		expect(ws.sent.filter((m) => m.type === 'pong').length).toBe(before + 1);
	});

	it('pings the server periodically and reconnects when the answers stop', async () => {
		vi.useFakeTimers();
		try {
			const messages = createStream<{ room: string }, never>('chat.socket.ts', 'messages');
			messages({ room: 'keepalive-room' });
			const ws = FakeWebSocket.last;
			await vi.advanceTimersByTimeAsync(0);
			ws.receive({ type: 'connection_ack' });

			// a live connection: the server answers our pings and nothing is torn down
			await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
			expect(ws.sent.filter((m) => m.type === 'ping')).toHaveLength(1);
			ws.receive({ type: 'pong' });
			await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
			expect(FakeWebSocket.last).toBe(ws);

			// …then the path goes half-open: pings still "send", nothing comes back
			await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
			expect(FakeWebSocket.last).not.toBe(ws); // reconnected on its own
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects in-flight mutations when the connection drops', async () => {
		const send = createMutate<{ text: string }, string>('chat.socket.ts', 'send');
		const ws = FakeWebSocket.last;
		await ws.ack();

		const pending = send({ text: 'never answered' });
		await tick();

		ws.close();
		await tick();

		const error = await pending.then(
			() => null,
			(e) => e
		);
		expect(isSocketError(error)).toBe(true);
		expect(error.issues[0].message).toMatch(/connection lost/i);
	});

	it('reports the connection status a UI can render', async () => {
		const messages = createStream<{ room: string }, string>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'status-room' });
		const ws = FakeWebSocket.last;
		await ws.ack();

		expect(feed.status).toBe('open');
		expect(feed.connected).toBe(true);

		// a drop is not a closure: the client is coming back, and says so
		ws.close();
		await tick();
		expect(feed.status).toBe('reconnecting');
		expect(feed.connected).toBe(false);

		// an explicit retry skips the backoff and puts a fresh socket in place
		feed.reconnect();
		await FakeWebSocket.last.ack();
		expect(feed.status).toBe('open');
	});

	it('resubscribes from the last cursor it received, closing the gap a drop leaves', async () => {
		const messages = createStream<{ room: string }, { id: string }>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'cursor-room' });
		const ws = FakeWebSocket.last;
		await ws.ack();

		const first = ws.sent.findLast((m) => m.type === 'stream')! as StreamMessage;
		expect(first.since).toBeUndefined(); // nothing to resume from yet
		ws.receive({ type: 'next', id: first.id, payload: { id: 'm1' }, cursor: 'm1' });

		feed.reconnect();
		await tick();
		const fresh = FakeWebSocket.last;
		await fresh.ack();

		const again = fresh.sent.findLast(
			(m) => m.type === 'stream' && JSON.stringify(m.payload).includes('cursor-room')
		)! as StreamMessage;
		expect(again.since).toBe('m1');
	});

	it('reconnects with a fresh socket and re-subscribes active streams', async () => {
		const messages = createStream<{ room: string }, never>('chat.socket.ts', 'messages');
		const feed = messages({ room: 'reconnect-room' });
		const old = FakeWebSocket.last;
		await tick();

		feed.reconnect();
		await tick();
		const fresh = FakeWebSocket.last;
		expect(fresh).not.toBe(old);

		await fresh.ack();
		expect(fresh.sent[0]).toEqual({ type: 'connection_init' });
		const resub = fresh.sent.filter((m) => m.type === 'stream');
		expect(resub.some((m) => JSON.stringify(m.payload).includes('reconnect-room'))).toBe(true);
	});

	it('throws the stream error out of a for-await instead of just finishing', async () => {
		const failing = createStream<null, number>('nums.socket.ts', 'fails');
		const feed = failing(null);
		const ws = FakeWebSocket.last;
		await ws.ack();
		const streamMsg = ws.sent.findLast(
			(m) => m.type === 'stream' && m.export === 'fails'
		)! as StreamMessage;

		const seen: number[] = [];
		const loop = (async () => {
			for await (const value of feed) seen.push(value);
		})();
		await tick();
		ws.receive({ type: 'next', id: streamMsg.id, payload: 1 });
		ws.receive({ type: 'error', id: streamMsg.id, errors: [{ message: 'boom' }] });
		ws.receive({ type: 'complete', id: streamMsg.id });

		const error = await loop.then(
			() => null,
			(e: unknown) => e
		);
		expect(isSocketError(error) && error.message).toBe('boom');
		expect(seen).toEqual([1]);
	});

	it('releases a subscription once, however often return() is called', async () => {
		const shared = createStream<{ k: string }, number>('nums.socket.ts', 'twice');
		const iterated = shared({ k: 'x' });
		const held = shared({ k: 'x' }); // a second holder of the same subscription
		const ws = FakeWebSocket.last;
		await ws.ack();
		const streamMsg = ws.sent.findLast(
			(m) => m.type === 'stream' && m.export === 'twice'
		)! as StreamMessage;

		const iterator = iterated[Symbol.asyncIterator]();
		await iterator.return!();
		await iterator.return!();
		await tick();

		// `held` still holds it, so the server must not be told to stop
		expect(ws.sent).not.toContainEqual({ type: 'complete', id: streamMsg.id });
		expect(held.status).toBe('open');
	});
});
