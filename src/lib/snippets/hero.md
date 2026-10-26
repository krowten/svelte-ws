```ts
// chat.socket.ts — server code, compiled away from the client
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

```svelte
<script>
	// the same import, in a component — now it's a reactive WS client
	import { messages, send } from './chat.socket';

	const feed = messages({ room: 'general' });
</script>

{feed.current?.text}
<button onclick={() => send({ room: 'general', text: 'hi' })}>Send</button>
```
