# The pub/sub bus

`svelte-ws/pubsub` is a standalone channel bus, deliberately not coupled to the WebSocket
layer. Import it inside any server code and publish or subscribe at will:

```ts
import { stream, mutate } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';

// a stream (or a native query.live) relays a channel to its client…
export const messages = stream(roomSchema, async function* ({ room }) {
	yield* subscribe(`room:${room}`);
});

// …and a mutate, a remote command, a +server.ts or a webhook publishes to it
export const send = mutate(messageSchema, ({ room, text }) => publish(`room:${room}`, { text }));
```

## One bus, every transport

The active engine is a single instance (pinned to `globalThis`), so every server context
shares it. That makes transports composable:

```ts
// chat.remote.ts — a plain HTTP remote command (remote functions are still behind
// `experimental: { remoteFunctions: true }` in the SvelteKit config)
import { command } from '$app/server';
import { publish } from 'svelte-ws/pubsub';

export const sendViaHttp = command(messageSchema, ({ room, text }) => {
	publish(`room:${room}`, { text }); // WebSocket subscribers see it live
});
```

A message published over HTTP shows up in every WebSocket `stream` subscribed to the
channel. It works the other way around too: a socket `mutate` can feed an SSE
`query.live`.

## API

| Function                            | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `publish(channel, payload)`         | deliver `payload` to every subscriber of `channel`        |
| `subscribe<T>(channel)`             | `AsyncIterableIterator<T>` of payloads until you `return` |
| `getPubSub()` / `setPubSub(engine)` | read / replace the active engine                          |
| `createInMemoryPubSub()`            | the default engine, explicitly                            |

Subscriptions are per-consumer FIFO queues, so no events are dropped between yields. A
channel is reclaimed when its last subscriber leaves.

## Ending a subscription

Inside a `stream` handler, `subscribe()` ends with the stream: the moment the client
unsubscribes or disconnects, the subscription closes, even on a channel nobody publishes to.
There is nothing to pass.

Everywhere else (a `query.live` body, a background job) there is no stream to follow, so
pass a signal of your own:

```ts
const ac = new AbortController();
for await (const event of subscribe('jobs', { signal: ac.signal })) {
	if (await handle(event)) ac.abort();
}
```

Without one, the subscription only ends when the channel next publishes. An async
generator's own `.return()` gets queued behind a `yield*` delegate's pending `next()`
rather than interrupting it, so on an idle channel the subscription, and the memory it
holds, outlives whoever asked for it. A signal settles the pending read directly.

## Swapping the engine

An engine is two methods:

```ts
export type PubSubEngine = {
	publish(channel: string, payload: unknown): void | Promise<void>;
	subscribe<T = unknown>(channel: string, options?: SubscribeOptions): AsyncIterableIterator<T>;
};
```

A custom engine should pass `options.signal` through (or honour it itself): that is what
ends a subscription on an idle channel the moment its client leaves. Inside a stream
`subscribe()` fills it in for you.

Replace it once at server start. The natural place is the `init` hook of
[`socket.config.ts`](/server-config):

```ts
import { defineSocketServer } from 'svelte-ws/config';
import { setPubSub } from 'svelte-ws/pubsub';
import { createRedisPubSub } from '#lib/server/redis-pubsub.js';

export default defineSocketServer({
	init() {
		setPubSub(createRedisPubSub());
	}
});
```

See [Redis pub/sub](/redis) for a complete engine backed by Bun's built-in Redis client,
with an ioredis variant for Node.
