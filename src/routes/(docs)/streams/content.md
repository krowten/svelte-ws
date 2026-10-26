# Streams & mutations

Everything you export from a `*.socket.ts` file is one of two things. `stream()` pushes a
live sequence of values from the server to the client, like `query.live`; `mutate()` runs a
one-shot write and returns its result, like `command`. Both validate their arguments with
any Standard Schema library, and components call them as ordinary imports.

## `stream(schema?, handler)`

A live stream. The handler is an async generator (or any `AsyncIterable`) whose yielded
values are pushed to the client; the analogue of `query.live`.

```ts
import { stream } from 'svelte-ws';
import { subscribe } from 'svelte-ws/pubsub';
import * as v from 'valibot';

export const messages = stream(v.object({ room: v.string() }), async function* ({ room }, ctx) {
	// runs on the server; ends when the client unsubscribes or disconnects
	yield* subscribe(`room:${room}`);
});
```

The optional first argument is a schema, any
[Standard Schema](https://standardschema.dev) library: valibot, zod, arktype and so on.
Client arguments are validated before the handler runs, and failures reach the client as
typed issues.

The second handler argument is the context, `{ signal, request, data }`:

- `signal` is an `AbortSignal` that fires when the client unsubscribes or disconnects;
- `request` is the WebSocket upgrade `Request` (headers, cookies, URL);
- `data` is whatever the [`upgrade` hook](/server-config) attached.

### The client handle

Calling a stream export in a component returns a reactive handle:

```svelte
<script>
	import { messages } from './chat.socket';

	const feed = messages({ room: 'general' });
</script>

{feed.current}
<!-- latest value (undefined before the first) -->
{feed.error}
<!-- issues from the server, if the stream failed -->
{feed.connected}
<!-- live socket state -->
{feed.status}
<!-- 'connecting' | 'open' | 'reconnecting' | 'closed' -->
<button onclick={() => feed.reconnect()}>Reconnect</button>
```

`status` is what you render. A first connection (`connecting`) deserves a spinner and a
dropped one (`reconnecting`) deserves a banner, and `connected` alone can't tell them
apart: it is simply `status === 'open'`.

The handle is also async-iterable for imperative consumption:

```ts
for await (const message of messages({ room: 'general' })) {
	console.log(message);
}
```

The loop does not queue values. If several arrive while its body is still running, the
next iteration gets the latest one and the others are skipped: a live stream carries
state, not an event log. When every event matters, yield them in batches.

Handles with the same module, export and (deeply equal) arguments share one server
subscription. Mount the same stream in ten components and the server runs one generator;
the subscription is released when the last owner is destroyed.

Reconnection is automatic, with jittered exponential backoff (250 ms up to 10 s, reset on a
successful handshake). On reconnect every active stream re-subscribes transparently, and
the client also reconnects when the browser fires `online`.

Keepalive runs in both directions. The server pings every 15 s and drops a client that
stops answering (close code `4408`); the client pings too, and reconnects on its own when
answers stop coming. This matters because a half-open connection (laptop sleep, NAT
timeout, flaky mobile network) never fires `close`, so without the pings the app would look
connected while receiving nothing.

If the connection drops while a `mutate` is still waiting for its result, the promise
rejects with a `SocketError` ("Connection lost before the server answered") instead of
hanging forever. The server may still have applied the write, so retrying is your call.

## `mutate(schema?, handler)`

A one-shot write over the same socket; the analogue of `command`:

```ts
import { mutate } from 'svelte-ws';
import { publish } from 'svelte-ws/pubsub';

export const send = mutate(messageSchema, ({ room, text }, ctx) => {
	const message = { id: crypto.randomUUID(), text, at: Date.now() };
	publish(`room:${room}`, message);
	return message; // resolved on the client
});
```

On the client it's just an async function:

```ts
const saved = await send({ room: 'general', text: 'hi' });
```

Validation and handler errors reject the promise with a `SocketError` carrying
`issues: { message, path? }[]`. With `messageSchema` requiring `text`, leaving it out is
enough:

```ts
import { isSocketError } from 'svelte-ws/client';

try {
	await send({ room: 'general' });
} catch (error) {
	if (isSocketError(error)) console.log(error.issues);
}
```

Operations from one client run concurrently, so two `send()` calls are not guaranteed to
finish in the order they were made. When order matters, `await` the first before starting
the second.

## During SSR

There is no socket on the server, so a stream rendered during SSR has no value yet:
`current` is `undefined` and `status` is `'closed'`. The subscription starts once the
component hydrates, and the first value replaces the placeholder. Render something for
the empty state (`{feed.current ?? '…'}`); a mutation called during SSR rejects.

## What the browser sees of a socket module

In the browser, a `*.socket.ts` file exposes only its `stream()` and `mutate()` exports;
the Vite plugin replaces the module with client stubs for those. Importing anything else
from it in a component, such as a schema or a helper, fails the build. Put shared code in
an ordinary module and import it from both sides.

## Reconnecting and resuming a stream

Reconnecting re-subscribes every live stream, but anything published while the client was
away is simply gone: a hole in the feed after every tunnel, lift or laptop lid. Give the
stream a cursor and it can close that hole itself:

```ts
export const messages = stream(
	roomSchema,
	async function* ({ room }, ctx) {
		// ctx.since is the cursor of the last value this client actually received
		if (ctx.since) yield* messagesAfter(room, ctx.since);
		yield* subscribe(roomChannel(room));
	},
	{ cursor: (message) => message.id }
);
```

The client remembers the cursor of every value it receives and sends the last one back as
`ctx.since` when it re-subscribes; on a fresh subscription `ctx.since` is `undefined`. What
a cursor _means_ is up to you (a message id, a timestamp, a log offset), and so is where
the replay comes from: a database, a Redis stream, an in-memory ring buffer.

Delivery is at-least-once. A replay may overlap with what already arrived, so key your UI
by id (`{#each history as message (message.id)}`) and let duplicates collapse.

`ctx.since` comes from the client, like any argument, and nothing ties it to the values
that client was actually sent. Check its shape before it reaches a query, and make the
replay return only what this connection may see (by room and by `ctx.data`), never
"everything after this id".

Streams without a `cursor` behave exactly as before: nothing is tagged, nothing is
resumed.

## Connection-scoped data

The [`upgrade` hook](/server-config) can attach data to the connection, and every handler
on that connection sees it:

```ts
export const whoami = mutate((_args, ctx) => ctx.data.userId ?? null);
```

## Every export is a public endpoint

A `*.socket.ts` export is reachable by anyone who can open the socket. The client names
the module and the export, and the server runs it; which component imports it, or whether
that page is even reachable in your UI, does not matter:

```ts
// admin.socket.ts — importing this only from /admin protects nothing
export const deleteUser = mutate(idSchema, ({ id }) => db.users.delete(id));
```

Exactly like SvelteKit's remote functions, authorisation belongs in the handler, or in the
[`upgrade` hook](/server-config) for the whole connection at once:

```ts
import { mutate, socketError } from 'svelte-ws';

export const deleteUser = mutate(idSchema, ({ id }, ctx) => {
	if (!ctx.data.isAdmin) throw socketError('Not allowed');
	return db.users.delete(id);
});
```

## Errors

Two kinds of error cross the wire verbatim: validation failures, and errors you raise
deliberately with `socketError(message)` (exported from `svelte-ws`). Everything else is
redacted and the client gets `"Internal Error"`, because a stray `Error` may carry a
connection string, a filesystem path or a SQL fragment. Under `vite dev` the real message
is shown instead, the same bargain SvelteKit strikes. The original always reaches your
`handleError` hook, which logs it and may decide what the client sees; without the hook it
goes to `console.error`.

A stream that fails this way ends: `error` holds the issues, and a `for await` over it
throws the `SocketError` instead of finishing quietly.

```ts
// socket.config.ts
handleError(error, { operation, data }) {
	logger.error({ error, operation, user: data.userId });
	return [{ message: 'Something went wrong, try again' }]; // optional override
}
```

## Limits

Every connection runs under guard rails with working defaults: frame size, concurrent
operations, and how much a slow reader may buffer before its stream pauses. See
[socket.config.ts](/server-config).

## The wire protocol

One WebSocket per app, in the style of graphql-ws: a `connection_init`/`connection_ack`
handshake, client-generated operation ids, `next`/`result`/`error`/`complete` frames and
app-level ping/pong keepalive (either peer drops the connection when pongs stop). As in
graphql-ws, a client that starts an operation under an id still in use gets the connection
closed with `4409`: any answer under that id would read as the end of the original
operation. The client in this package never reuses ids. You never deal with any of this
directly, but it's all in `protocol.ts` if you're curious.
