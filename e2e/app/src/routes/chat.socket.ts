import type { ChatMessage } from './chat-shared';

import { stream, mutate } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';
import {
	liveSubscriptions,
	messageSchema,
	newMessage,
	roomChannel,
	roomSchema
} from './chat-shared';

/**
 * Stream messages posted to a room. Declaring a `cursor` makes it resumable: after a
 * reconnect the client sends back the id of the last message it saw, and `ctx.since` lets
 * the handler replay the gap (a real app would read them from its store — this fixture
 * keeps a small in-memory log).
 */
export const messages = stream(
	roomSchema,
	async function* ({ room }, ctx) {
		liveSubscriptions.set(room, (liveSubscriptions.get(room) ?? 0) + 1);
		try {
			if (ctx.since) yield* history(room, ctx.since);
			// no `signal` passed: inside a stream, subscribe() ends with the stream by itself,
			// which the "quiet room" test checks on both servers
			yield* subscribe<ChatMessage>(roomChannel(room));
		} finally {
			liveSubscriptions.set(room, (liveSubscriptions.get(room) ?? 1) - 1);
		}
	},
	{ cursor: (message: ChatMessage) => message.id }
);

/** Everything posted per room, so a resumed stream can replay what a client missed. */
const log = new Map<string, ChatMessage[]>();

function remember(room: string, message: ChatMessage): void {
	const room_log = log.get(room) ?? [];
	room_log.push(message);
	log.set(room, room_log.slice(-100));
}

function* history(room: string, since: unknown): Generator<ChatMessage> {
	const room_log = log.get(room) ?? [];
	const from = room_log.findIndex((message) => message.id === since);
	if (from !== -1) yield* room_log.slice(from + 1);
}

/** Post a message to a room over the socket; every subscriber receives it. */
export const send = mutate(messageSchema, ({ room, text }) => {
	const message = newMessage(text);
	remember(room, message);
	publish(roomChannel(room), message);
	return message;
});

/** The per-connection `visitor` id assigned by the `upgrade` hook in `socket.config.ts`. */
// `visitor` is a string here purely through the config's upgrade hook: no cast, and
// `.slice()` would not compile if the inference broke — that makes check:e2e a real test
export const whoami = mutate((_args, ctx) => ctx.data.visitor.slice(0, 8));
