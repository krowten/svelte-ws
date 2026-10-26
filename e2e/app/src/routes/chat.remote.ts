import { command } from '$app/server';
import { publish } from 'svelte-ws/pubsub';
import { messageSchema, newMessage, roomChannel } from './chat-shared';

/**
 * A regular SvelteKit remote `command` (HTTP) that publishes to the **same bus** as the
 * WebSocket `stream`. Proves the bus is transport-agnostic: a message sent over HTTP shows
 * up live in the socket subscribers. The reverse (`query.live` reading `subscribe(...)`)
 * works the same way.
 */
export const sendViaCommand = command(messageSchema, ({ room, text }) => {
	const message = newMessage(text);
	publish(roomChannel(room), message);
	return message;
});
