import type { SocketServerHooks } from './config.js';

import { describe, expect, it } from 'vitest';
import { defineSocketServer, resolveHooks, sameOriginCheck } from './config.js';

describe('socket server config', () => {
	it('defineSocketServer is an identity helper', () => {
		const hooks: SocketServerHooks = { init: () => {} };
		expect(defineSocketServer(hooks)).toBe(hooks);
	});

	it('resolveHooks passes an object through', async () => {
		const hooks: SocketServerHooks = {};
		await expect(resolveHooks(hooks, { dev: true })).resolves.toBe(hooks);
	});

	it('resolveHooks calls a config function with the context', async () => {
		let seen: boolean | undefined;
		const hooks = await resolveHooks(
			({ dev }) => {
				seen = dev;
				return { upgrade: () => undefined };
			},
			{ dev: false }
		);
		expect(seen).toBe(false);
		expect(hooks.upgrade).toBeTypeOf('function');
	});

	it('resolveHooks awaits an async config function', async () => {
		const hooks = await resolveHooks(async () => ({ init: () => {} }), { dev: true });
		expect(hooks.init).toBeTypeOf('function');
	});

	it('resolveHooks returns empty hooks for null/undefined', async () => {
		await expect(resolveHooks(null, { dev: true })).resolves.toEqual({});
		await expect(resolveHooks(undefined, { dev: true })).resolves.toEqual({});
	});

	it('sameOriginCheck ignores case and the default port in Host', () => {
		const check = (origin: string, host: string) =>
			sameOriginCheck(origin, {
				request: new Request('http://internal/_events', { headers: { host } }),
				server: null,
				dev: false
			});
		expect(check('https://example.com', 'Example.com')).toBe(true);
		expect(check('https://example.com', 'example.com:443')).toBe(true);
		expect(check('http://example.com:8080', 'example.com:8080')).toBe(true);
		expect(check('https://evil.com', 'example.com')).toBe(false);
		expect(check('https://example.com', 'example.com:8443')).toBe(false);
	});
});
