import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

/**
 * Graceful shutdown against a server of its own: the shared ones have to outlive the run.
 * Uses the builds the suite's web servers just made, and a deadline far above what a clean
 * shutdown needs and far below `SHUTDOWN_TIMEOUT`, so a WebSocket that kept the server
 * alive would fail the test instead of merely slowing it down.
 */
const APP = path.resolve(import.meta.dirname, '../app');
const SHUTDOWN_TIMEOUT = 20;

const servers = {
	bun: ['bun', './build-bun/index.js'],
	node: ['node', './build-node/index.js']
} as const;

async function freePort(): Promise<number> {
	const probe = createServer().listen(0, '127.0.0.1');
	await once(probe, 'listening');
	const { port } = probe.address() as { port: number };
	probe.close();
	return port;
}

test('SIGTERM closes live WebSockets with 1001, runs cleanup and exits', async () => {
	const testInfo = test.info();
	test.skip(testInfo.project.name.endsWith('webkit'), 'no browser involved; once per runtime');
	const runtime = testInfo.project.name as keyof typeof servers;
	const [command, entry] = servers[runtime];

	const port = await freePort();
	const server = spawn(command, [entry], {
		cwd: APP,
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			SHUTDOWN_TIMEOUT: String(SHUTDOWN_TIMEOUT)
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	server.stdout.on('data', (chunk) => (output += chunk));
	server.stderr.on('data', (chunk) => (output += chunk));
	const exited = once(server, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

	try {
		await expect
			.poll(() =>
				fetch(`http://127.0.0.1:${port}/`).then(
					(r) => r.status,
					() => 0
				)
			)
			.toBe(200);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/_events`);
		const closed = new Promise<CloseEvent>((resolve) => (ws.onclose = resolve));
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
			ws.onmessage = (event) => {
				if (JSON.parse(String(event.data)).type === 'connection_ack') resolve();
			};
			ws.onerror = () => reject(new Error(`WebSocket failed:\n${output}`));
		});

		const started = Date.now();
		server.kill('SIGTERM');

		const close = await closed;
		expect(close.code).toBe(1001);
		expect(close.reason).toBe('server shutting down');

		const [code] = await exited;
		expect(code, output).toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
		// socket.config's `init` cleanup ran on `sveltekit:shutdown`
		expect(output).toContain('[socket] shutdown');
	} finally {
		if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
	}
});
