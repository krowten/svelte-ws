import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as connectRaw } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import * as v from 'valibot';
import { attachNodeWebSocket } from './node-ws.js';
import { createWebSocketHandler } from './ws-handler.js';
import { mutate, stream } from './define.js';
import type { AnyDescriptor } from '../types.js';
import type { SocketServerHooks } from '../config.js';
import type { ServerMessage } from '../protocol.js';

const ENDPOINT = '/_events';

/** A raw upgrade request, as a client opening a WebSocket would send it. */
const upgradeRequest = (path: string) =>
	`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
	'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

/** Socket module the tests resolve against. */
const descriptors: Record<string, AnyDescriptor> = {
	echo: mutate(v.object({ text: v.string() }), ({ text }) => `echo:${text}`) as never,
	whoami: mutate((_args, ctx) => ctx.data.visitor ?? null) as never,
	ticks: stream(async function* () {
		yield 1;
		yield 2;
	}) as never
};

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

let closeWebSockets: (() => Promise<void>) | undefined;

/** Start an http server with the bridge attached, return its base URL. */
async function listen(
	hooks: SocketServerHooks = {},
	onError?: (error: unknown) => void
): Promise<string> {
	const server = createServer((_req, res) => res.end('http'));
	servers.push(server);

	closeWebSockets = attachNodeWebSocket({
		server,
		endpoint: ENDPOINT,
		dev: false,
		runtime: () => ({
			hooks,
			handler: createWebSocketHandler({ resolve: (_module, name) => descriptors[name] })
		}),
		onError
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

type Client = {
	socket: WebSocket;
	/** Wait for the next message of a given type. */
	next(type: ServerMessage['type']): Promise<ServerMessage>;
	send(message: unknown): void;
	upgradeHeaders: Promise<Record<string, unknown>>;
};

function connect(
	base: string,
	headers: Record<string, string> = {},
	wsOptions: Record<string, unknown> = {}
): Client {
	const socket = new WebSocket(base.replace('http', 'ws') + ENDPOINT, { headers, ...wsOptions });
	sockets.push(socket);

	const received: ServerMessage[] = [];
	const waiters: { type: string; resolve: (message: ServerMessage) => void }[] = [];

	socket.on('message', (raw) => {
		const message = JSON.parse(String(raw)) as ServerMessage;
		const waiter = waiters.findIndex((w) => w.type === message.type);
		if (waiter === -1) received.push(message);
		else waiters.splice(waiter, 1)[0].resolve(message);
	});

	const upgradeHeaders = new Promise<Record<string, unknown>>((resolve, reject) => {
		socket.on('upgrade', (response) => resolve(response.headers));
		socket.on('error', reject);
	});
	// not every test awaits the headers; a rejected upgrade must not become an
	// unhandled rejection in those that don't
	upgradeHeaders.catch(() => {});

	return {
		socket,
		upgradeHeaders,
		send: (message) => socket.send(JSON.stringify(message)),
		next(type) {
			const buffered = received.findIndex((message) => message.type === type);
			if (buffered !== -1) return Promise.resolve(received.splice(buffered, 1)[0]);
			return new Promise((resolve) => waiters.push({ type, resolve }));
		}
	};
}

/** Handshake, then return the client. */
async function handshake(base: string, headers?: Record<string, string>): Promise<Client> {
	const client = connect(base, headers);
	await new Promise((resolve, reject) => {
		client.socket.on('open', resolve);
		client.socket.on('error', reject);
	});
	client.send({ type: 'connection_init' });
	await client.next('connection_ack');
	return client;
}

describe('attachNodeWebSocket', () => {
	it('leaves other paths alone', async () => {
		const base = await listen();
		const response = await fetch(base + '/not-events');
		expect(await response.text()).toBe('http');
	});

	it('runs the full handshake and a mutation over ws', async () => {
		const base = await listen();
		const client = await handshake(base);

		client.send({ type: 'mutate', id: '1', module: 'm', export: 'echo', payload: { text: 'hi' } });
		await expect(client.next('result')).resolves.toEqual({
			type: 'result',
			id: '1',
			payload: 'echo:hi'
		});
	});

	it('drives streams to completion', async () => {
		const base = await listen();
		const client = await handshake(base);

		client.send({ type: 'stream', id: 's1', module: 'm', export: 'ticks', payload: null });
		await expect(client.next('next')).resolves.toMatchObject({ payload: 1 });
		await expect(client.next('next')).resolves.toMatchObject({ payload: 2 });
		await expect(client.next('complete')).resolves.toMatchObject({ id: 's1' });
	});

	it('passes the upgrade hook’s data to handlers and its headers to the 101', async () => {
		const base = await listen({
			upgrade: ({ request, dev }) => {
				expect(dev).toBe(false);
				expect(request.headers.get('x-test')).toBe('yes');
				return {
					data: { visitor: 'v42' },
					headers: { 'set-cookie': 'visitor=v42; Path=/' }
				};
			}
		});

		const client = await handshake(base, { 'x-test': 'yes' });
		expect((await client.upgradeHeaders)['set-cookie']).toEqual(['visitor=v42; Path=/']);

		client.send({ type: 'mutate', id: '1', module: 'm', export: 'whoami', payload: null });
		await expect(client.next('result')).resolves.toMatchObject({ payload: 'v42' });
	});

	it('rejects the upgrade when the hook returns a Response', async () => {
		const base = await listen({
			upgrade: () => new Response('nope', { status: 401 })
		});

		const client = connect(base);
		const error = await new Promise<Error>((resolve) => client.socket.on('error', resolve));
		expect(error.message).toMatch(/401/);
	});

	it('closes live sockets so shutdown can drain, and stays safe with none open', async () => {
		const base = await listen();
		const client = await handshake(base);

		const closed = new Promise<number>((resolve) => client.socket.on('close', resolve));
		await closeWebSockets!();
		// 1001 "going away" — the client learns why instead of seeing a dropped TCP socket
		expect(await closed).toBe(1001);

		// a server nobody ever connected to never loaded `ws`; closing must still resolve
		await listen();
		await expect(closeWebSockets!()).resolves.toBeUndefined();
	});

	it('reports upgrade failures through onError instead of crashing', async () => {
		const server = createServer((_req, res) => res.end('http'));
		servers.push(server);
		const errors: unknown[] = [];

		attachNodeWebSocket({
			server,
			endpoint: ENDPOINT,
			dev: true,
			runtime: () => {
				throw new Error('config blew up');
			},
			onError: (error) => errors.push(error)
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const socket = new WebSocket(`ws://127.0.0.1:${port}${ENDPOINT}`);
		sockets.push(socket);

		await new Promise((resolve) => socket.on('error', resolve));
		expect((errors[0] as Error).message).toBe('config blew up');
	});

	it('closes only the offending connection when a frame exceeds maxPayloadBytes', async () => {
		const base = await listen();
		const client = await handshake(base);

		const closed = new Promise<number>((resolve) => client.socket.on('close', resolve));
		client.socket.send('x'.repeat(2 * 1024 * 1024)); // default limit is 1 MiB
		await closed;

		// the server itself — and a fresh connection — must still be alive
		const other = await handshake(base);
		other.send({ type: 'mutate', id: '1', module: 'm', export: 'echo', payload: { text: 'hi' } });
		await expect(other.next('result')).resolves.toMatchObject({ payload: 'echo:hi' });
	});

	it('does not crash on a request-target the WHATWG URL constructor rejects', async () => {
		const base = await listen();
		const { port } = new URL(base);

		const raw = connectRaw(Number(port), '127.0.0.1');
		raw.on('error', () => {});
		raw.write(
			'GET http://[bad/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
				'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
		);
		await once(raw, 'close').catch(() => {});

		// the server must still accept normal connections afterwards
		const client = await handshake(base);
		client.send({ type: 'mutate', id: '1', module: 'm', export: 'echo', payload: { text: 'hi' } });
		await expect(client.next('result')).resolves.toMatchObject({ payload: 'echo:hi' });
	});

	it('rejects a mismatched Origin by default, and allows a matching one', async () => {
		const base = await listen();
		const { port } = new URL(base);

		const foreign = connect(base, {}, { origin: 'https://foreign.invalid' });
		const foreignError = await new Promise<Error>((resolve) => foreign.socket.on('error', resolve));
		expect(foreignError.message).toMatch(/403/);

		const same = connect(base, {}, { origin: `http://127.0.0.1:${port}` });
		await new Promise<void>((resolve, reject) => {
			same.socket.on('open', resolve);
			same.socket.on('error', reject);
		});
	});

	it('lets checkOrigin override the default policy', async () => {
		const base = await listen({ checkOrigin: (origin) => origin === 'https://trusted.example' });

		const untrusted = connect(base, {}, { origin: 'https://foreign.invalid' });
		await expect(
			new Promise((_resolve, reject) => untrusted.socket.on('error', reject))
		).rejects.toThrow(/403/);

		const trusted = connect(base, {}, { origin: 'https://trusted.example' });
		await new Promise<void>((resolve, reject) => {
			trusted.socket.on('open', resolve);
			trusted.socket.on('error', reject);
		});
	});

	it('survives a client that resets the connection while the upgrade hook runs', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let reached!: () => void;
		const hookRunning = new Promise<void>((resolve) => (reached = resolve));
		const errors: unknown[] = [];
		let calls = 0;
		const base = await listen(
			{
				// only the first upgrade (the one that resets) is held up and refused
				upgrade: async () => {
					if (calls++ > 0) return;
					reached();
					await gate;
					return new Response('no', { status: 401 });
				}
			},
			(error) => errors.push(error)
		);

		const raw = connectRaw(Number(new URL(base).port), '127.0.0.1');
		raw.on('error', () => {});
		raw.write(upgradeRequest(ENDPOINT));
		await hookRunning;
		raw.resetAndDestroy(); // RST: the server side's next read fails with ECONNRESET
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));

		// still serving, and the reset went to onError instead of crashing the process
		const client = await handshake(base);
		client.send({ type: 'mutate', id: '1', module: 'm', export: 'echo', payload: { text: 'hi' } });
		await expect(client.next('result')).resolves.toMatchObject({ payload: 'echo:hi' });
	});

	it('closes an upgrade to another path when nothing else handles it', async () => {
		const base = await listen();
		const raw = connectRaw(Number(new URL(base).port), '127.0.0.1');
		raw.on('error', () => {});
		raw.write(upgradeRequest('/elsewhere'));
		await expect(once(raw, 'close')).resolves.toBeDefined();
	});
});
