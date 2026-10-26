import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	MutateDescriptor,
	MutateFn,
	MutateHandler,
	StreamDescriptor,
	StreamFn,
	StreamHandler,
	StreamOptions
} from '../types.js';

type Output<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;
/**
 * What the client actually sends — distinct from {@link Output} for a transforming schema
 * (`v.pipe(v.string(), v.transform(Number))`: the wire payload is a string, the handler's
 * `args` is the number). The client stub has to be typed on this, not `Output`, or
 * TypeScript would accept calls with the wrong shape and reject the ones that are correct.
 */
type Input<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;

/**
 * Define a real-time **stream** in a `*.socket.ts` file. The handler is an async generator
 * (or any `AsyncIterable`) whose yielded values stream to the client over the shared
 * WebSocket — analogous to SvelteKit's `query.live`.
 *
 * Channels are not part of the signature: relay one inside the body via the bus,
 * `yield* subscribe('room:' + room)` (from `svelte-ws/pubsub`). If the first argument is a
 * Standard Schema, the client payload is validated against it.
 *
 * The returned value is callable on the client (`messages({ room })`) and yields a reactive
 * `Stream`; the Vite plugin compiles the server handler away from the client bundle.
 *
 * Pass `{ cursor }` to make the stream resumable: the client remembers the cursor of the
 * last value it received and sends it back as `ctx.since` after a reconnect, so the handler
 * can replay whatever the disconnect swallowed.
 *
 * ```ts
 * export const messages = stream(
 *   roomSchema,
 *   async function* ({ room }, ctx) {
 *     if (ctx.since) yield* await messagesAfter(room, ctx.since);
 *     yield* subscribe(roomChannel(room));
 *   },
 *   { cursor: (message) => message.id }
 * );
 * ```
 */
export function stream<T>(
	handler: StreamHandler<void, T>,
	options?: StreamOptions<T>
): StreamFn<void, T>;
export function stream<Schema extends StandardSchemaV1, T>(
	schema: Schema,
	handler: StreamHandler<Output<Schema>, T>,
	options?: StreamOptions<T>
): StreamFn<Input<Schema>, T>;
export function stream(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schemaOrHandler: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handlerOrOptions?: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	maybeOptions?: any
): unknown {
	// `stream(handler, options?)` or `stream(schema, handler, options?)`
	const schemaFirst = typeof handlerOrOptions === 'function';
	const [schema, handler, options] = schemaFirst
		? [schemaOrHandler as StandardSchemaV1, handlerOrOptions, maybeOptions]
		: [null, schemaOrHandler as StreamHandler<unknown, unknown>, handlerOrOptions];

	assertHandler('stream', handler);
	const descriptor: StreamDescriptor = { kind: 'stream', schema, handler, options };
	// Runtime value is the descriptor (read by the server router); the client type is the
	// callable stub, which the Vite plugin substitutes for the browser bundle.
	return descriptor;
}

/**
 * Define a **mutate** in a `*.socket.ts` file — a one-shot write over the same WebSocket,
 * typically publishing to a channel via `publish('room:' + room, payload)` (from
 * `svelte-ws/pubsub`). Analogous to a remote `command`.
 *
 * If the first argument is a Standard Schema, the client payload is validated against it.
 */
export function mutate<R>(handler: MutateHandler<void, R>): MutateFn<void, R>;
export function mutate<Schema extends StandardSchemaV1, R>(
	schema: Schema,
	handler: MutateHandler<Output<Schema>, R>
): MutateFn<Input<Schema>, R>;
export function mutate(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schemaOrHandler: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	maybeHandler?: any
): unknown {
	const [schema, handler] = maybeHandler
		? [schemaOrHandler as StandardSchemaV1, maybeHandler]
		: [null, schemaOrHandler as MutateHandler<unknown, unknown>];

	assertHandler('mutate', handler);
	const descriptor: MutateDescriptor = { kind: 'mutate', schema, handler };
	return descriptor;
}

/** A missing handler would otherwise only surface when a client first calls it. */
function assertHandler(kind: 'stream' | 'mutate', handler: unknown): void {
	if (typeof handler !== 'function') {
		throw new TypeError(`${kind}() needs a handler function, after the schema if there is one`);
	}
}
