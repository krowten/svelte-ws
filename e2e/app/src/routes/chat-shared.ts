import * as v from 'valibot';

export type ChatMessage = { id: string; text: string; at: number };

export const roomSchema = v.object({ room: v.string() });

export const messageSchema = v.object({
	room: v.string(),
	text: v.pipe(v.string(), v.minLength(1), v.maxLength(500))
});

/** Channel name for a room — the only place the channel string is defined. */
export const roomChannel = (room: string) => `room:${room}`;

export const newMessage = (text: string): ChatMessage => ({
	id: crypto.randomUUID(),
	text,
	at: Date.now()
});

/**
 * Open `messages` streams per room on this server, for the e2e suite to read through
 * `/live`. Pinned to globalThis: the WebSocket runtime and SvelteKit's routes are separate
 * entries of the server build and may each get their own copy of this module.
 */
export const liveSubscriptions: Map<string, number> = ((
	globalThis as { [key: symbol]: Map<string, number> | undefined }
)[Symbol.for('e2e.liveSubscriptions')] ??= new Map());
