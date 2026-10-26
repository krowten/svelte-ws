import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { createTestClient } from './testing.js';
import { mutate, stream } from './server/define.js';
import { socketError } from './server/validate.js';
import { publish, subscribe } from './pubsub.js';

/** A socket module of the shape a consumer would write, used by most tests below. */
const chat = {
	send: mutate(v.object({ room: v.string(), text: v.string() }), ({ room, text }) => {
		publish(`room:${room}`, { text });
		return { text };
	}),
	messages: stream(v.object({ room: v.string() }), async function* ({ room }) {
		yield* subscribe<{ text: string }>(`room:${room}`);
	}),
	whoami: mutate((_args, ctx) => ctx.data.visitor ?? null),
	boom: mutate(() => {
		throw socketError('nope');
	}),
	ticks: stream(async function* () {
		yield 1;
		yield 2;
	}),
	resumable: stream(
		async function* (_args, ctx) {
			yield `since:${String(ctx.since)}`;
		},
		{ cursor: (value: string) => value }
	)
};

const modules = { 'chat.socket.ts': chat };

describe('createTestClient', () => {
	it('runs a mutation through the real handler and its schema', async () => {
		const client = createTestClient({ modules });

		await expect(
			client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'hi' })
		).resolves.toEqual({ text: 'hi' });

		await expect(client.mutate('chat.socket.ts', 'send', { room: 'a' })).rejects.toMatchObject({
			name: 'SocketError',
			issues: [expect.objectContaining({ path: ['text'] })]
		});

		await client.close();
	});

	it('answers keepalive pings, so a long test is not dropped for going quiet', async () => {
		vi.useFakeTimers();
		try {
			const client = createTestClient({ modules });
			await client.mutate('chat.socket.ts', 'whoami');

			// well past pingInterval + pongTimeout (25s): without pongs the server would close
			await vi.advanceTimersByTimeAsync(60_000);

			expect(client.sent.filter((message) => message.type === 'ping').length).toBeGreaterThan(1);
			await expect(client.mutate('chat.socket.ts', 'whoami')).resolves.toBeNull();
			await client.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it('streams values published by a mutation, and stops on close', async () => {
		const client = createTestClient({ modules });
		const feed = client.stream<{ text: string }>('chat.socket.ts', 'messages', { room: 'a' });

		await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'one' });
		await expect(feed.next()).resolves.toEqual({ value: { text: 'one' }, done: false });

		await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'two' });
		await expect(feed.next()).resolves.toEqual({ value: { text: 'two' }, done: false });
		expect(feed.received).toEqual([{ text: 'one' }, { text: 'two' }]);

		await feed.close();
		// nothing reaches a closed stream, and the server was told to stop
		await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'three' });
		expect(feed.received).toHaveLength(2);

		await client.close();
	});

	it('works with `for await`, ending when the handler does', async () => {
		const client = createTestClient({ modules });

		const seen: number[] = [];
		for await (const tick of client.stream<number>('chat.socket.ts', 'ticks')) seen.push(tick);

		expect(seen).toEqual([1, 2]);
		await client.close();
	});

	it('gives handlers the data the upgrade hook returned', async () => {
		const client = createTestClient({
			modules,
			request: new Request('http://localhost/_events', { headers: { cookie: 'visitor=v42' } }),
			hooks: {
				upgrade: ({ request }) => ({
					data: { visitor: request.headers.get('cookie')?.split('=')[1] }
				})
			}
		});

		await expect(client.mutate('chat.socket.ts', 'whoami')).resolves.toBe('v42');
		await client.close();
	});

	it('surfaces an upgrade hook that rejects the connection', async () => {
		const client = createTestClient({
			modules,
			hooks: { upgrade: () => new Response('nope', { status: 401 }) }
		});

		await expect(client.mutate('chat.socket.ts', 'whoami')).rejects.toThrow(/401/);
		// closing a client that never connected is fine, and nothing is left to reject later
		await expect(client.close()).resolves.toBeUndefined();
	});

	it('passes `since` to a resumable stream', async () => {
		const client = createTestClient({ modules });
		const feed = client.stream<string>('chat.socket.ts', 'resumable', undefined, { since: 7 });

		await expect(feed.next()).resolves.toMatchObject({ value: 'since:7' });
		await client.close();
	});

	it('reports thrown errors, and routes them through handleError', async () => {
		const handleError = vi.fn(() => undefined);
		const client = createTestClient({ modules, hooks: { handleError } });

		await expect(client.mutate('chat.socket.ts', 'boom')).rejects.toMatchObject({
			issues: [{ message: 'nope' }]
		});
		expect(handleError).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'nope' }),
			expect.objectContaining({ operation: expect.objectContaining({ export: 'boom' }) })
		);

		await client.close();
	});

	it('complains about a module nobody registered', async () => {
		const client = createTestClient({ modules });

		await expect(client.mutate('missing.socket.ts', 'send')).rejects.toMatchObject({
			issues: [expect.objectContaining({ message: expect.stringContaining('missing.socket.ts') })]
		});

		await client.close();
	});

	it('exposes every frame the server sent', async () => {
		const client = createTestClient({ modules });
		await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'hi' });

		expect(client.sent.map((message) => message.type)).toEqual(['connection_ack', 'result']);
		await client.close();
	});

	it('closing ends live streams and fails pending work', async () => {
		const client = createTestClient({ modules });
		const feed = client.stream('chat.socket.ts', 'messages', { room: 'a' });
		const pending = feed.next();

		await client.close();

		await expect(pending).resolves.toEqual({ value: undefined, done: true });
		await expect(client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'x' })).rejects.toThrow(
			/closed/
		);
		// a subscribe after close fails on the stream rather than somewhere nobody is looking
		await expect(client.stream('chat.socket.ts', 'messages', { room: 'a' }).next()).rejects.toThrow(
			/closed/
		);
	});

	it('resolves a pending next() when the stream itself is closed, not just the whole client', async () => {
		const client = createTestClient({ modules });
		const feed = client.stream('chat.socket.ts', 'messages', { room: 'a' });
		const pending = feed.next();

		await Promise.race([
			feed.close(),
			new Promise((_r, reject) => setTimeout(() => reject(new Error('close() hung')), 200))
		]);

		await expect(pending).resolves.toEqual({ value: undefined, done: true });
		await client.close();
	});

	it('applies socket.config limits, not just an explicit override', async () => {
		const client = createTestClient({
			modules,
			hooks: { limits: { maxOperations: 1 } }
		});

		client.stream('chat.socket.ts', 'messages', { room: 'a' });
		await expect(client.mutate('chat.socket.ts', 'whoami')).rejects.toMatchObject({
			issues: [{ message: expect.stringContaining('Too many concurrent operations') }]
		});

		await client.close();
	});

	it('lets an explicit limits override win over socket.config for the same key', async () => {
		const client = createTestClient({
			modules,
			hooks: { limits: { maxOperations: 1 } },
			limits: { maxOperations: 2 }
		});

		client.stream('chat.socket.ts', 'messages', { room: 'a' });
		await expect(client.mutate('chat.socket.ts', 'whoami')).resolves.toBeNull();

		await client.close();
	});

	it('redacts errors when asked to, exactly as production would', async () => {
		const client = createTestClient({
			modules: { 'chat.socket.ts': { crash: mutate(() => JSON.parse('{')) } },
			exposeErrors: false
		});

		await expect(client.mutate('chat.socket.ts', 'crash')).rejects.toMatchObject({
			issues: [{ message: 'Internal Error' }]
		});

		await client.close();
	});
});
