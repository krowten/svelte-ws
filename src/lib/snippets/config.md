```ts
// socket.config.ts — one config for `vite dev` and the built server
import { defineSocketServer } from 'svelte-ws/config';
import { setPubSub } from 'svelte-ws/pubsub';

export default defineSocketServer({
	// startup: connect, swap the bus, return a cleanup
	init: async () => {
		setPubSub(createRedisPubSub());
		return () => db.close();
	},

	// authenticate once, per connection
	upgrade: ({ request }) => {
		const session = read(request.headers.get('cookie'));
		if (!session) return new Response(null, { status: 401 });
		return { data: { userId: session.userId } };
	},

	limits: { maxOperations: 64 },
	handleError: (error) => logger.error(error)
});
```
