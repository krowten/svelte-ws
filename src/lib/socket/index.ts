/**
 * `svelte-ws` — author remote functions over a WebSocket in `*.socket.ts` files.
 *
 * This library is **only** the WebSocket transport for remote functions (the `.remote.ts`
 * equivalent over WS): `stream` (live read) and `mutate` (write). Pub/sub is a separate,
 * optional concern — see `svelte-ws/pubsub` — usable identically from these functions and
 * from native SvelteKit `command`/`query.live`/`+server.ts`.
 *
 * ```ts
 * // chat.socket.ts
 * import { stream, mutate } from 'svelte-ws';
 * import { publish, subscribe } from 'svelte-ws/pubsub'; // optional helper
 * import * as v from 'valibot';
 *
 * export const messages = stream(v.object({ room: v.string() }), async function* ({ room }) {
 *   yield* subscribe(`room:${room}`);
 * });
 *
 * export const send = mutate(
 *   v.object({ room: v.string(), text: v.string() }),
 *   ({ room, text }) => publish(`room:${room}`, { text })
 * );
 * ```
 *
 * The Vite plugin compiles each `*.socket.ts` into a server registry and a client WS-proxy,
 * exactly like SvelteKit remote functions. This entry is the server half and never reaches
 * the browser bundle.
 *
 * Error contract: throw `socketError('message')` for anything the user should read — those
 * cross the wire verbatim. Every other thrown value is redacted to "Internal Error" and
 * handed to the `handleError` hook of `socket.config.ts` instead.
 */
/**
 * Per-connection data attached by the `upgrade` hook of `socket.config.ts`, surfaced to
 * every handler as `ctx.data`.
 *
 * Untyped by default. Point it at your own config once and every handler in the app gets
 * the real shape — no casts, no duplication:
 *
 * ```ts
 * // src/app.d.ts
 * import type { InferSocketData } from 'svelte-ws/config';
 * import type socketConfig from '../socket.config.js';
 *
 * declare module 'svelte-ws' {
 *   // eslint-disable-next-line @typescript-eslint/no-empty-object-type
 *   interface SocketData extends InferSocketData<typeof socketConfig> {}
 * }
 * ```
 *
 * Declaring the members by hand works just as well when you would rather not import the
 * config. This is an `interface` on purpose — only interfaces merge across modules.
 */
export interface SocketData {
	[key: string]: unknown;
}

export { stream, mutate } from './server/define.js';
export { socketError, validationError, isValidationError } from './server/validate.js';
export { isSocketError } from './error.js';

export type { InferSocketData } from './config.js';
export type { SocketError } from './error.js';
export type { ValidationError } from './server/validate.js';
export type { SocketContext, Stream, StreamFn, MutateFn, Issue } from './types.js';
