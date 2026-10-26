# SvelteKit remote functions over WebSocket

SvelteKit remote functions are functions you export from `*.remote.ts` files and call from anywhere in your app, while they always run on the server: `query` for reads, `form` and `command` for writes, `prerender` for static data, and `query.live` for real-time data. svelte-ws applies the same authoring model to WebSockets. You write `stream()` and `mutate()` in `*.socket.ts` files, validate arguments with the same Standard Schema libraries, and import the exports straight into components. Everything runs over one multiplexed WebSocket instead of one HTTP request per call. You keep `query` and `form` where they fit and use sockets where a live connection pays off.

## How the two map onto each other

| SvelteKit remote function | svelte-ws equivalent     | Transport                          | Direction                            | Use it when                                                                                                                    |
| ------------------------- | ------------------------ | ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `query`                   | none, keep using `query` | HTTP (`fetch`)                     | request, one response                | Reads that should render on the server, be cached by arguments and refreshed on demand.                                        |
| `query.live`              | `stream()`               | HTTP stream vs one WebSocket       | server to client, until unsubscribed | Data that keeps arriving. Choose `stream()` when the same connection should also carry writes, or `ctx.data` from the upgrade. |
| `command`                 | `mutate()`               | HTTP `fetch` vs the same WebSocket | client to server, one reply          | Writes that are not tied to a form element. Choose `mutate()` when you are already connected and writes are frequent.          |
| `form`                    | none, keep using `form`  | HTTP                               | client to server, one reply          | Writes that must work without JavaScript. SvelteKit recommends `form` over `command` where possible.                           |
| `prerender`               | none                     | build time                         | static                               | Data that does not change between deployments.                                                                                 |

What the two sides share:

- **Validation.** The first argument of `query`, `command`, `form`, `stream()` and `mutate()` is an optional [Standard Schema](https://standardschema.dev) (valibot, zod, arktype and so on). Arguments are checked on the server before your handler runs. Every export is a public endpoint either way, so authorise inside the handler.
- **Module-level definitions.** You define the function once, import it in a component, and the build keeps the server code out of the browser bundle.
- **A handle with connection state.** A live query exposes `connected` and `reconnect()`; a stream handle exposes the same two, plus `current`, `error` and `status`.
- **Shared subscriptions.** Many components using the same function with the same arguments share one connection (SvelteKit) or one server subscription (svelte-ws).
- **Reconnection.** Both reconnect on their own with exponential backoff and again when the browser goes back online. svelte-ws also re-subscribes every active stream and can replay what was missed, see [resumable streams](/streams).

What differs, and is worth knowing before you port code:

- **Reading the value.** A live query is also a promise, so you can `{await time}` it, and it needs `compilerOptions.experimental.async`. A stream handle is a plain reactive object: read `.current`, which is `undefined` until the first value arrives.
- **Errors.** On a live query, `error` is `App.Error | undefined` in SvelteKit 3. On a stream it is a list of issues, `{ message, path? }[]`. A rejected `mutate()` throws a `SocketError` carrying the same `issues`.
- **Connection state.** `connected` exists on both. Only svelte-ws adds `status` (`'connecting'`, `'open'`, `'reconnecting'`, `'closed'`), which lets you show a spinner on the first connection and a banner on a dropped one.
- **Server-side rendering.** During SSR, `await getTime()` returns the first yielded value, which is serialized and reused during hydration. A stream handle is inert on the server (`current` is `undefined`, `status` is `'closed'`) and connects in the browser. Load first paint data with a `query`, and let a stream carry the updates.
- **Single-flight mutations.** A `command` can `refresh()` or `set()` queries, or `reconnect()` live queries, in the same response. `mutate()` has no such mechanism: it returns its handler's result, and anything else reaches the client through the stream you publish to.

## The same feature, both ways

A live chat room, first with SvelteKit remote functions.

```ts
// src/routes/chat/chat.remote.ts
import * as v from 'valibot';
import { query, command } from '$app/server';
import { publish, subscribe } from 'svelte-ws/pubsub';

const roomSchema = v.object({ room: v.string() });

export const messages = query.live(roomSchema, async function* ({ room }) {
	yield* subscribe(`room:${room}`);
});

export const send = command(v.object({ room: v.string(), text: v.string() }), ({ room, text }) => {
	publish(`room:${room}`, { text });
});
```

```svelte
<script>
	import { messages, send } from './chat.remote';

	const feed = messages({ room: 'general' });
</script>

<p>{feed.connected ? 'live' : 'reconnecting…'}</p>
<p>{feed.current?.text}</p>
<button onclick={() => send({ room: 'general', text: 'hi' })}>Say hi</button>
```

SvelteKit has no event bus of its own, so both versions use [`svelte-ws/pubsub`](/pubsub) as the source of events. Swap in your own emitter or database listener if you prefer; the shape of the remote functions does not change.

Now the same room with svelte-ws.

```ts
// src/routes/chat/chat.socket.ts
import * as v from 'valibot';
import { stream, mutate } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';

const roomSchema = v.object({ room: v.string() });

export const messages = stream(roomSchema, async function* ({ room }) {
	yield* subscribe(`room:${room}`);
});

export const send = mutate(v.object({ room: v.string(), text: v.string() }), ({ room, text }) => {
	publish(`room:${room}`, { text });
});
```

```svelte
<script>
	import { messages, send } from './chat.socket';

	const feed = messages({ room: 'general' });
</script>

<p>{feed.status === 'open' ? 'live' : 'reconnecting…'}</p>
<p>{feed.current?.text}</p>
<button onclick={() => send({ room: 'general', text: 'hi' })}>Say hi</button>
```

The diff is small. The file is `*.socket.ts`, `query.live` becomes `stream`, `command` becomes `mutate`, and the subscription ends the moment the client leaves. The component changes its import and, if it wants to, reads `status` instead of `connected`. What you gain is the WebSocket underneath: the `send` call travels on the connection that is already open, and a handler can read whatever the [`upgrade` hook](/server-config) attached to it. See [streams & mutations](/streams) for the full API.

## Using both together

The bus does not know about transports. Every server context in the process shares it, so a message published from a `command` reaches a WebSocket `stream`, and a message published from a socket `mutate` reaches a `query.live`:

```ts
// chat.remote.ts (HTTP)
export const sendViaHttp = command(messageSchema, ({ room, text }) => {
	publish(`room:${room}`, { text }); // WebSocket subscribers see it live
});

export const feed = query.live(roomSchema, async function* ({ room }) {
	yield* subscribe(`room:${room}`); // fed by socket mutations too
});
```

Any pairing of the four works. A common split is to post with a `form` (it works without JavaScript), load history with a `query`, and keep the live part on a socket `stream`. The default engine is in-memory, so once you run more than one server process, switch the bus to [Redis](/redis). See [the pub/sub bus](/pubsub) for the API and engine swapping.

## Remote functions are still experimental in SvelteKit 3

SvelteKit 3 is out, and remote functions are still behind flags. You opt in with `experimental.remoteFunctions` and `compilerOptions.experimental.async`, both passed to the `sveltekit()` plugin in `vite.config.ts` (SvelteKit 3 no longer reads `svelte.config.js`):

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: { experimental: { async: true } },
			experimental: { remoteFunctions: true }
		})
	]
});
```

SvelteKit's own docs call the feature experimental, likely to contain bugs and subject to change without notice. Without the flag, the mere presence of a file with a `remote` segment in its name (`chat.remote.ts`, `remote.ts`) is an error.

svelte-ws does not need either flag. A `*.socket.ts` file has no `remote` segment, so SvelteKit does not treat it as a remote module, and `sveltekitSocket()` compiles it itself into a client proxy plus a server registry. The stream handle is a plain reactive object that you read without `await`, so the async compiler option is not involved either. A SvelteKit 3.0.1 app with `*.socket.ts` modules and neither flag builds and serves. You only enable the flags if you also write `*.remote.ts` files, as in the examples on this page.

## Built for SvelteKit 3

svelte-ws needs SvelteKit 3 (`@sveltejs/kit` `^3.0.0`), Svelte 5 and Vite 6 or later as peer dependencies. The adapters are SvelteKit 3's official `adapter-node` and `adapter-bun` with a WebSocket endpoint added, so the public origin, environment variables and shutdown behave exactly as SvelteKit documents them. See [deployment](/deployment) and the [adapter](/adapter) reference.

## Next steps

- [Getting started](/getting-started): install svelte-ws and write your first socket module.
- [Streams & mutations](/streams): the full authoring API, cursors and error handling.
- [The pub/sub bus](/pubsub): share channels between HTTP and WebSocket functions.
- [Deployment](/deployment): `paths.origin` and reverse proxies.
