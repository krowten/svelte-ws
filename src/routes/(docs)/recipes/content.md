# Recipes

Patterns that come up in almost every realtime app. They use nothing beyond
[`stream` / `mutate`](/streams), the [bus](/pubsub) and the
[`upgrade` hook](/server-config); the point is how the pieces fit, not new API.

## Authenticating the connection

Authenticate once, at the upgrade, and every operation on that socket inherits the
answer. Returning a `Response` refuses the handshake, so an unauthenticated client never
gets a connection to abuse:

```ts
// socket.config.ts
import { defineSocketServer } from 'svelte-ws/config';

export default defineSocketServer({
	upgrade: async ({ request }) => {
		const session = await sessionFromCookie(request.headers.get('cookie'));
		if (!session) return new Response('Unauthorized', { status: 401 });

		return { data: { userId: session.userId, roles: session.roles } };
	}
});
```

Handlers read it from `ctx.data`, [typed from this very config](/server-config):

```ts
export const messages = stream(roomSchema, async function* ({ room }, ctx) {
	if (!(await canRead(ctx.data.userId, room))) throw socketError('Not allowed');
	yield* subscribe(`room:${room}`);
});
```

**Tokens instead of cookies.** Browsers can't set headers on a WebSocket handshake, and the
client always connects to the same-origin endpoint with no query string, so a bearer token
can't ride along on the socket itself. Trade it for a cookie scoped to the socket endpoint:
an HTTP endpoint checks the token and sets the cookie, and the upgrade reads it like any
session:

```ts
// src/routes/api/socket-session/+server.ts
export async function POST({ request, cookies }) {
	const user = await verifyBearer(request.headers.get('authorization'));
	if (!user) return new Response('Unauthorized', { status: 401 });
	cookies.set('socket_session', await issueSocketSession(user.id), {
		path: '/_events', // sent on the handshake and nowhere else
		httpOnly: true,
		sameSite: 'strict',
		maxAge: 60 * 60 // as long as the token itself stays valid
	});
	return new Response(null, { status: 204 });
}
```

```ts
// socket.config.ts
upgrade: async ({ request }) => {
	const id = parseCookies(request.headers.get('cookie')).socket_session;
	const user = id && (await lookupSocketSession(id));
	if (!user) return new Response('Unauthorized', { status: 401 });
	return { data: { userId: user.id } };
};
```

Call the endpoint once before the first stream or mutation. The cookie has to outlive
more than the first handshake: the client reconnects on its own after a network drop, and
each reconnect is a fresh upgrade that needs it again.

One caveat: sessions expire, sockets don't. A connection authenticated an hour ago is
still open. If that matters, re-check inside the handlers that need it, or close the
socket from `handleError`.

## Presence: who is in the room

Presence is just a stream whose cleanup runs when the client goes away. `ctx.signal`
fires on unsubscribe and on disconnect alike, which is the whole trick:

```ts
const present = new Map<string, Set<string>>(); // room -> user ids

export const presence = stream(roomSchema, async function* ({ room }, ctx) {
	const members = present.get(room) ?? new Set();
	present.set(room, members);

	members.add(ctx.data.userId);
	publish(`presence:${room}`, [...members]);

	ctx.signal.addEventListener('abort', () => {
		members.delete(ctx.data.userId);
		publish(`presence:${room}`, [...members]);
	});

	yield [...members]; // the joiner sees the room immediately
	yield* subscribe<string[]>(`presence:${room}`);
});
```

A `Map` works for one process. Across several, keep presence in Redis: a sorted set per
room scored by "last seen", with members re-added on a heartbeat and stale ones trimmed on
read. That survives the case a `Map` can't, a process dying without ever running its
cleanup.

## Typing indicators

Ephemeral signals are a `mutate` that publishes and stores nothing:

```ts
export const startTyping = mutate(roomSchema, ({ room }, ctx) => {
	publish(`typing:${room}`, { userId: ctx.data.userId, at: Date.now() });
});

export const typing = stream(roomSchema, async function* ({ room }) {
	yield* subscribe<{ userId: string; at: number }>(`typing:${room}`);
});
```

Let them expire on the client instead of sending a "stopped typing" event. A client that
disappears mid-keystroke never sends one, and you'd be waiting forever:

```svelte
<script>
	const events = typing({ room });
	let typists = $state(new Map());

	$effect(() => {
		const event = events.current;
		if (!event) return;
		typists.set(event.userId, event.at);
		const timer = setTimeout(() => typists.delete(event.userId), 3000);
		return () => clearTimeout(timer);
	});
</script>
```

Throttle the mutation to one call every second or so. A keystroke handler firing on every
character is a lot of frames for something nobody reads precisely.

## Optimistic updates

`mutate` returns the stored record, and the stream delivers it to everyone, including the
sender. Render your own message immediately, then let the authoritative copy replace it:

```svelte
<script>
	const feed = messages({ room });
	let pending = $state([]);

	async function submit(text) {
		const optimistic = { id: crypto.randomUUID(), text, pending: true };
		pending = [...pending, optimistic];
		try {
			const saved = await send({ room, text, clientId: optimistic.id });
			pending = pending.filter((m) => m.id !== optimistic.id);
			return saved;
		} catch (error) {
			// mark it failed rather than dropping it — the user typed that
			pending = pending.map((m) => (m.id === optimistic.id ? { ...m, failed: true } : m));
		}
	}
</script>
```

Echo the client's own id back from the handler (`clientId` above) so the incoming message
can be matched against the optimistic one. Without it, deduplication has to guess from text
and timestamps, and gets it wrong exactly when someone sends the same thing twice.

Remember that a `mutate` in flight when the connection drops rejects with "Connection
lost before the server answered", yet the server may still have applied it. For anything
that must not happen twice, give the operation an idempotency key (the same `clientId`
does the job) and have the handler ignore a repeat.

## Catching up after a reconnect

A reconnect re-subscribes, but the gap in between is yours to fill. Give the stream a
`cursor` and the client sends the last one it saw back as `ctx.since`:

```ts
export const messages = stream(
	roomSchema,
	async function* ({ room }, ctx) {
		// `since` comes from the client: check it before it reaches a query
		if (typeof ctx.since === 'string') yield* await messagesAfter(room, ctx.since);
		yield* subscribe(`room:${room}`);
	},
	{ cursor: (message) => message.id }
);
```

Make the replay overlap rather than risk a hole. An id the client already has is cheap to
drop; a message it never receives is gone for good.

## Rate limiting a connection

Per-connection state is a closure in the `upgrade` hook: it exists for as long as the socket
does, and disappears with it.

```ts
upgrade: () => {
	let tokens = 20;
	let refilled = Date.now();

	return {
		data: {
			spend() {
				const now = Date.now();
				tokens = Math.min(20, tokens + ((now - refilled) / 1000) * 5);
				refilled = now;
				if (tokens < 1) throw socketError('Slow down');
				tokens--;
			}
		}
	};
};
```

Refill by elapsed time rather than a `setInterval`: there is no per-connection "closed" hook
to clear a timer in, and a timer per socket that nothing stops is a leak with a schedule.

For limits that must hold across processes (and against someone opening fifty sockets),
count in Redis against the user id, not the connection. The
[per-connection guard rails](/server-config) (`maxOperations`, `maxPayloadBytes`,
backpressure) are the blunt instrument underneath this, and they apply whether or not you
add anything.
