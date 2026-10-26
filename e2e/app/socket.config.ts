import { defineSocketServer } from 'svelte-ws/config';

/**
 * Server config for `vite dev` and for both adapters' built servers. This demo config:
 * - `init` proves startup code runs (connect databases / `setPubSub(...)` here);
 * - `upgrade` assigns every connection a `visitor` id from (or into) a cookie and exposes
 *   it to handlers as `ctx.data.visitor`.
 */
export default defineSocketServer(({ dev }) => ({
	init() {
		console.log(`[socket] init (${dev ? 'dev' : 'prod'})`);
		return () => console.log('[socket] shutdown');
	},

	upgrade({ request }) {
		const cookie = request.headers.get('cookie') ?? '';
		const existing = /(?:^|;\s*)visitor=([\w-]+)/.exec(cookie)?.[1];
		const visitor = existing ?? crypto.randomUUID().slice(0, 8);
		return {
			data: { visitor },
			// set-cookie on the 101 upgrade response — the browser stores it like any other
			headers: existing ? undefined : { 'set-cookie': `visitor=${visitor}; Path=/; SameSite=Lax` }
		};
	}
}));
