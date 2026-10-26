# What is svelte-ws?

svelte-ws brings the remote functions authoring model to WebSockets. Where SvelteKit's
`*.remote.ts` gives you `query` and `command` over HTTP, svelte-ws gives you `stream` and
`mutate` over a single multiplexed WebSocket, in `*.socket.ts` files:

```ts
// chat.socket.ts
import { stream, mutate } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';
import * as v from 'valibot';

export const messages = stream(v.object({ room: v.string() }), async function* ({ room }) {
	yield* subscribe(`room:${room}`);
});

export const send = mutate(v.object({ room: v.string(), text: v.string() }), ({ room, text }) =>
	publish(`room:${room}`, { text })
);
```

A component imports those exports directly. On the client the Vite plugin swaps the server
code for a thin proxy, so `messages({ room })` returns a reactive handle and `send(...)`
resolves over the socket. Server code never reaches the browser bundle.

```svelte
<script>
	import { messages, send } from './chat.socket';

	const feed = messages({ room: 'general' });
</script>

<p>{feed.status === 'open' ? 'live' : 'reconnecting…'}</p><p>{feed.current?.text}</p>
```

## The pieces

- **The definers.** `stream()` is a live, cancellable async-generator stream, like
  `query.live`. `mutate()` is a one-shot write, like `command`. Arguments validate against
  any [Standard Schema](https://standardschema.dev) library.
- **The pub/sub bus.** A standalone `publish`/`subscribe` module that every transport
  shares: socket handlers, HTTP remote functions and `+server.ts` all see the same
  channels. It is in-memory by default; a [Redis engine](/redis) fans it out across instances.
- **The Vite plugin.** Compiles `*.socket.ts` into client stubs plus a server registry, and
  serves the WebSocket endpoint on the dev server itself.
- **The adapters.** SvelteKit's official `adapter-node` and `adapter-bun` with a WebSocket
  endpoint added: native Bun WebSockets on one, the `ws` package on the other. They bring
  the Vite plugin along, so the adapter is the only thing to configure. See
  [adapters](/adapter).
- **`socket.config.ts`.** One config for startup code, upgrade auth, limits and WebSocket
  tuning, identical in dev and production. See [server config](/server-config).

## Why not SSE / query.live?

`query.live` over SSE works well for server-to-client streams. A WebSocket adds what SSE
can't do:

- client-to-server messages on the same connection, so mutations don't pay an HTTP
  round-trip per call;
- one connection for the whole app. Every stream and mutation multiplexes over it, with
  per-operation ids, keepalive and cancellation (the protocol resembles graphql-ws);
- connection-scoped state: authenticate once at upgrade, and every handler sees
  `ctx.data`.

The bus doesn't care about transports, so you can mix freely: publish from an HTTP
`command`, observe from a WebSocket `stream`, or the other way around. [Remote functions
over WebSocket](/remote-functions) maps the two models onto each other, and
[Alternatives](/compare) weighs svelte-ws against Socket.IO, svelte-realtime and SSE.

## Requirements

- **SvelteKit 3** with Vite
- **Bun ≥ 1.4** or **Node ≥ 22.17** for the production server; `vite dev` needs no particular
  runtime, since the WebSocket endpoint runs on the dev server itself
- any Standard Schema validator (valibot, zod, arktype, …), if you want validation

## Where to go next

[Getting started](/getting-started) gets a first socket module running in `vite dev`.
[Streams & mutations](/streams) is the authoring reference, [the pub/sub bus](/pubsub)
connects handlers to each other, and [testing](/testing) covers socket modules without a
server. For production, read [adapters](/adapter) and [deployment](/deployment).
