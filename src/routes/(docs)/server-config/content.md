# socket.config.ts

One file at the project root drives both `vite dev` and the built server, so startup code
and WebSocket behaviour stay identical across environments. The default export is a hooks
object, or a function `({ dev }) => hooks`:

```ts
import { defineSocketServer } from 'svelte-ws/config';

export default defineSocketServer(({ dev }) => ({
	init() {
		/* … */
	},
	upgrade({ request }) {
		/* … */
	}
}));
```

The adapter's Vite plugin discovers `socket.config.ts` / `socket.config.js` automatically,
or takes an explicit path: `adapter({ socket: { config: './server/socket.config.ts' } })`. The file is
compiled through the server build, so `#lib`, `$app/env` and friends all work inside it.

## `init`: run code at server start

Connect databases, swap the pub/sub engine, warm caches. Runs before the server accepts
traffic; an optionally returned function runs on graceful shutdown.

```ts
init: async ({ dev }) => {
	await db.connect();
	setPubSub(createRedisPubSub()); // see Redis pub/sub
	return () => db.close(); // cleanup on shutdown
};
```

## `checkOrigin`: guard against cross-site WebSocket hijacking

Runs before `upgrade`, on every handshake. The default rejects a mismatched `Origin` with
`403`: a browser sends `Origin` on every WebSocket connection, same-origin or not, so
comparing it against the request's own `Host` is the standard mitigation for cross-site
WebSocket hijacking (a malicious page opening a connection to your app using the visitor's
cookies) — whether or not your `upgrade` hook happens to rely on cookies. A request with no
`Origin` header (curl, a native client, a server-to-server call) is let through, since only
a browser sends one.

That makes it a guard against other sites, not authentication: anything that isn't a
browser can connect, so `upgrade` (or each handler) still has to decide who the client is.
Behind a proxy that rewrites `Host`, forward the public one (nginx: `proxy_set_header Host
$host`) or the check fails every browser with `403`.

```ts
checkOrigin: (origin, { request }) => {
	// an allowlist for a separate frontend origin, in addition to same-origin
	return origin === null || origin === 'https://app.example.com';
};
```

Pass `checkOrigin: () => true` to disable the check entirely — reasonable for non-browser
clients that authenticate some other way.

## `upgrade`: intercept every WebSocket handshake

Authenticate, read/set cookies and headers, attach per-connection data. Return:

- nothing, to accept with defaults;
- `{ data, headers }` to accept: `data` becomes `ctx.data` in every handler on that
  connection, and `headers` are sent with the `101` response (yes, `set-cookie` works
  there);
- a `Response`, to reject the upgrade with it.

```ts
upgrade: ({ request }) => {
	const session = parseSession(request.headers.get('cookie'));
	if (!session) return new Response('Unauthorized', { status: 401 });

	return {
		data: { userId: session.userId },
		headers: { 'set-cookie': refreshSession(session) }
	};
};
```

Handlers receive the data on their context:

```ts
export const whoami = mutate((_args, ctx) => ctx.data.userId);
```

### Typing `ctx.data`

`upgrade` decides what every handler on that connection sees as `ctx.data`. Point the
type at your own config once and the whole app follows, without casts or a second source
of truth:

```ts
// src/app.d.ts
import type { InferSocketData } from 'svelte-ws';
import type socketConfig from '../socket.config.js';

declare module 'svelte-ws' {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface SocketData extends InferSocketData<typeof socketConfig> {}
}
```

(The empty body is how a computed type merges into an interface; typescript-eslint's
`no-empty-object-type` flags that shape, hence the disable comment.)

```ts
// any *.socket.ts — `userId` is a string here, checked at compile time
export const whoami = mutate((_args, ctx) => ctx.data.userId.toUpperCase());
```

Declaring the members by hand works too if you would rather not import the config:

```ts
declare module 'svelte-ws' {
	interface SocketData {
		userId: string;
	}
}
```

Without either, `ctx.data` values are `unknown`: safe, just unhelpful.

## `websocket`: tune or observe the WebSocket handler

Wrap the handler the runtime built: change Bun WebSocket options or hook the lifecycle.
Applied in production, and (for the lifecycle callbacks) in dev too.

```ts
websocket: (handler) => ({
	...handler,
	maxPayloadLength: 1024 * 1024,
	perMessageDeflate: true,
	open: (ws) => {
		metrics.connections++;
		handler.open?.(ws); // keep the runtime's wiring!
	},
	close: (ws, code, reason) => {
		metrics.connections--;
		handler.close?.(ws, code, reason);
	}
});
```

## `limits`: guard rails per connection

Sensible defaults, override only what your workload needs:

```ts
export default defineSocketServer({
	limits: {
		maxPayloadBytes: 1024 * 1024, // largest frame from a client; a bigger one closes the connection
		maxOperations: 256, // live streams + in-flight mutations per connection
		maxBufferedBytes: 1024 * 1024, // streams and mutation results wait while the client is this far behind
		onBackpressure: 'close', // or 'wait' — what to do if it never drains
		backpressureTimeoutMs: 30_000,
		maxQueuedMessages: 1024 // pub/sub backlog per subscriber before the oldest are dropped
	}
});
```

`maxPayloadBytes` also configures the transport itself (Bun's `maxPayloadLength`, the `ws`
package's `maxPayload`), so oversized frames are rejected before they are buffered.

Backpressure is what keeps one slow reader from growing the server. A stream stops
producing while the socket is congested and resumes when it drains, so that client gets
slower updates instead of the process getting fatter. A mutation result waits the same
way. If the socket stays congested past `backpressureTimeoutMs`, `onBackpressure: 'close'`
closes the connection with `1011`.

Errors and keepalive replies can't wait, so on a congested socket they get a budget of
another `maxBufferedBytes`. A client that keeps sending requests past it without reading
the answers is closed with `1011` even under `onBackpressure: 'wait'`: that client is not
slow, it is not reading at all.

## `handleError`: logging, and what the client is allowed to see

Unexpected errors never cross the wire verbatim: the client gets `"Internal Error"`. This
hook receives the original:

```ts
handleError(error, { request, data, operation }) {
	logger.error({ error, operation }); // operation: { module, export, kind }
	// optional: replace the generic message with something useful
	return [{ message: 'Something went wrong, try again' }];
}
```

Validation failures and errors raised with `socketError(message)` are considered intentional
and reach the client unchanged.

## Dev / prod differences

| Hook        | `vite dev`               | built server                         |
| ----------- | ------------------------ | ------------------------------------ |
| `init`      | ✅ on dev-server start   | ✅ before the server starts          |
| `upgrade`   | ✅ (`server` is `null`)  | ✅ (`server` is the platform server) |
| `websocket` | lifecycle callbacks only | ✅ everything                        |

`vite dev` loads `socket.config.ts` when the dev server starts and again whenever you save
it: the cleanup from the previous `init` runs first, then the new config applies to the
next connection. If it fails to load, every upgrade is refused with `500` until it is
fixed.

`ctx.server` is typed as `unknown` so the package stays runtime-agnostic. Cast it when
you need the specifics, e.g. `(ctx.server as import('bun').Server).publish(...)`.
