# Testing WebSocket handlers

A `*.socket.ts` module is ordinary server code, but its handlers only make sense over a
connection: `ctx.data`, `ctx.since`, validation, the pub/sub fan-out and the unsubscribe
signal all come from the protocol. `svelte-ws/testing` gives you that protocol without a
server. Both ends of the socket live in memory, and everything in between is the real
implementation.

```ts
import { createTestClient } from 'svelte-ws/testing';
import * as chat from './chat.socket.js';

const client = createTestClient({ modules: { 'chat.socket.ts': chat } });
```

The key of `modules` is how the client addresses a module. In your app the Vite plugin
derives it from the file path; in a test you pick it yourself. Import the module normally:
in Vitest's server-side tests (the default `node` environment) the plugin leaves
`*.socket.ts` modules alone, so what you get is the server side, not the client stubs a
component would see.

## Mutations

```ts
await expect(
	client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'hi' })
).resolves.toMatchObject({ text: 'hi' });
```

Schemas run first, exactly as in production. An invalid payload rejects with a
`SocketError` carrying `issues`, and never reaches your handler:

```ts
await expect(client.mutate('chat.socket.ts', 'send', { room: 'a' })).rejects.toMatchObject({
	issues: [{ path: ['text'] }]
});
```

## Streams

`client.stream(...)` returns an async iterator that also remembers what it has seen:

```ts
const feed = client.stream('chat.socket.ts', 'messages', { room: 'a' });

await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'one' });
expect((await feed.next()).value).toMatchObject({ text: 'one' });
expect(feed.received).toHaveLength(1);

await feed.close(); // unsubscribes, as a client going away would
```

Unlike the client handle, which keeps only the latest value, a test stream buffers every
value it receives, so a test can step through them one by one.

`for await` works too, and ends when the handler's generator does:

```ts
const seen = [];
for await (const tick of client.stream('clock.socket.ts', 'ticks')) seen.push(tick);
```

To exercise a [resumable stream](/streams), pass the cursor a reconnecting client would
have sent. The handler receives it as `ctx.since`:

```ts
const feed = client.stream('chat.socket.ts', 'messages', { room: 'a' }, { since: 'm7' });
```

## Hooks, identity and errors

The `upgrade` hook runs for real, so `ctx.data` in a test is whatever your production hook
would have attached. That makes authorisation testable without a browser:

```ts
const client = createTestClient({
	modules: { 'chat.socket.ts': chat },
	request: new Request('http://localhost/_events', { headers: { cookie: 'session=abc' } }),
	hooks: {
		upgrade: async ({ request }) => ({ data: { user: await userFromCookie(request) } })
	}
});
```

A hook that returns a `Response` rejects the connection, and the first operation throws
with its status: the same "no" a browser would get. `handleError` is called for handler
failures, so you can assert your redaction and logging. Note that errors are not redacted
by default here (`exposeErrors: true`), since `Internal Error` tells a failing test
nothing. Pass `exposeErrors: false` to check what a production client would actually see.

`limits` accepts the same [guard rails](/server-config) as the server config, which is the
practical way to test them. Set `maxOperations: 1` and watch the second subscription get
refused.

## The protocol itself

`client.sent` is every frame the server produced, in order, for when the assertion is
about the protocol rather than the payload:

```ts
expect(client.sent.map((m) => m.type)).toEqual(['connection_ack', 'result']);
```

Finish with `await client.close()`, ideally in an `afterEach`. It aborts running streams
(so `ctx.signal` fires and your cleanup runs), ends every iterator and rejects anything
still pending. That last part is also how you test what your handlers do when a client
disappears.
