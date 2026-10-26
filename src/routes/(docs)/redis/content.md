# Redis pub/sub

The bus is in-memory by default, which is exactly right for a single instance. To fan
messages out across instances, or to share channels with non-JS producers, swap the engine
for Redis once at server start.

On Bun there is nothing to install: it ships a Redis client
([docs](https://bun.com/docs/api/redis); pub/sub needs Bun ≥ 1.2.23). On Node any client
works, and [the ioredis variant](#on-the-node-adapter) is below. Either way you need
Redis ≥ 7.2, and the connection URL comes from `REDIS_URL` (falling back to
`redis://localhost:6379`).

## The engine

A subscribed Redis connection can _only_ subscribe, so publishing needs a second
connection; hence the two clients. Locally the engine reuses the in-memory bus for
fan-out, which keeps iterator semantics (per-subscriber FIFO, cleanup on `return`)
identical to the default engine.

```ts
// src/lib/server/redis-pubsub.ts
import { RedisClient } from 'bun';
import { createInMemoryPubSub, type PubSubEngine, type SubscribeOptions } from 'svelte-ws/pubsub';

export function createRedisPubSub(url?: string): PubSubEngine {
	const publisher = new RedisClient(url);
	const subscriber = new RedisClient(url); // subscribing takes over this connection
	const local = createInMemoryPubSub();
	const subscribed = new Map<string, number>(); // channel → local subscriber count

	return {
		async publish(channel, payload) {
			await publisher.publish(channel, JSON.stringify(payload));
		},

		subscribe<T>(channel: string, options?: SubscribeOptions) {
			const count = subscribed.get(channel) ?? 0;
			subscribed.set(channel, count + 1);
			if (count === 0) {
				// first local subscriber → subscribe on Redis and relay into the local bus
				subscriber
					.subscribe(channel, (message) => {
						// anything else sharing this Redis may publish non-JSON on the channel
						try {
							local.publish(channel, JSON.parse(message));
						} catch {
							console.warn(`[redis-pubsub] dropped a non-JSON message on ${channel}`);
						}
					})
					.catch((err) => {
						console.error(`[redis-pubsub] subscribe ${channel} failed`, err);
						subscribed.delete(channel); // the next subscriber tries again
					});
			}

			// pass `options` on: it carries the `signal` that ends an idle subscription promptly
			const iterator = local.subscribe<T>(channel, options);
			let released = false;
			const release = () => {
				// `return()` runs twice when a signal ends the subscription: count it once
				if (released) return;
				released = true;
				const left = (subscribed.get(channel) ?? 1) - 1;
				if (left <= 0) {
					subscribed.delete(channel);
					subscriber
						.unsubscribe(channel)
						.catch((err) => console.error(`[redis-pubsub] unsubscribe ${channel} failed`, err));
				} else {
					subscribed.set(channel, left);
				}
			};

			// run the Redis cleanup when the consumer stops iterating
			const originalReturn = iterator.return?.bind(iterator);
			iterator.return = (value?: unknown) => {
				release();
				return originalReturn ? originalReturn(value) : Promise.resolve({ value, done: true });
			};
			return iterator;
		}
	};
}
```

## On the Node adapter

The engine never mentions Bun; only the two client calls do. With
[ioredis](https://github.com/redis/ioredis) the differences from the code above are
mechanical:

```ts
import Redis from 'ioredis';

const publisher = new Redis(url ?? process.env.REDIS_URL ?? 'redis://localhost:6379');
const subscriber = new Redis(url ?? process.env.REDIS_URL ?? 'redis://localhost:6379');

// delivery arrives through one listener instead of a per-channel callback — register once
subscriber.on('message', (channel, message) => {
	try {
		local.publish(channel, JSON.parse(message));
	} catch {
		console.warn(`[redis-pubsub] dropped a non-JSON message on ${channel}`);
	}
});
```

…and the per-channel calls become `subscriber.subscribe(channel)` (no callback
argument) and `subscriber.unsubscribe(channel)`, each with the same `.catch`: an unhandled
rejection there (Redis restarting, say) is fatal to a Node process. Everything else stays the same
file: the local fan-out, the reference counting, the cleanup on `return`.

## Wiring it up in socket.config.ts

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

Nothing else changes: every `stream`/`mutate`, native `command`/`query.live` and
`+server.ts` that uses `publish`/`subscribe` now talks through Redis. Payloads must be
JSON-serialisable (they already had to be to cross the WebSocket).

## Notes

- Bun's Redis pub/sub is channel-based (`subscribe`). Pattern subscriptions
  (`PSUBSCRIBE`) aren't in the typed API; send raw commands via `client.send()` if you
  need them.
- `RedisClient` auto-reconnects (up to 20 retries) and queues commands while offline.
- Messages published _by this instance_ also come back through Redis, so publishers hear
  their own messages exactly once, same as with the in-memory engine.
