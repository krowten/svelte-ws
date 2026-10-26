import type { SocketWebSocketHandler } from './server/ws-handler.js';
import type { Issue } from './protocol.js';

/**
 * Server configuration for the socket runtime — one `socket.config.ts` at the project root
 * drives **both** `vite dev` and the built Bun server, so startup code and WebSocket
 * behaviour stay identical across environments.
 *
 * ```ts
 * // socket.config.ts
 * import { defineSocketServer } from 'svelte-ws/config';
 *
 * export default defineSocketServer(({ dev }) => ({
 *   async init() {
 *     await db.connect();                       // runs once at server start
 *     setPubSub(createRedisPubSub());           // see docs/redis.md
 *     return () => db.close();                  // optional cleanup on shutdown
 *   },
 *   upgrade({ request }) {
 *     const session = readSession(request.headers.get('cookie'));
 *     if (!session) return new Response('Unauthorized', { status: 401 });
 *     return { data: { session }, headers: { 'set-cookie': refresh(session) } };
 *   },
 *   websocket: (handler) => ({ ...handler, maxPayloadLength: 1024 * 1024 })
 * }));
 * ```
 */

/** Passed to the config function and to `init` — distinguishes `vite dev` from the built server. */
export type SocketServerContext = { dev: boolean };

/** Cleanup callback optionally returned by `init`, invoked on graceful shutdown. */
export type InitCleanup = () => void | Promise<void>;

/**
 * What an `upgrade` hook may return:
 * - `void`/`undefined` — accept with defaults;
 * - `{ data, headers }` — accept; `data` becomes `ctx.data` in every handler, `headers` are
 *   sent with the `101` response (e.g. `set-cookie`);
 * - a `Response` — reject the upgrade with that response.
 */
export type UpgradeResult =
	{ data?: Record<string, unknown>; headers?: HeadersInit } | Response | void;

export type UpgradeContext = {
	/** The WebSocket upgrade request (headers, cookies, URL). */
	request: Request;
	/**
	 * The platform server in production — Bun's `Server` with the Bun adapter, a
	 * `node:http` `Server` with the Node adapter — and `null` under `vite dev`. Typed as
	 * `unknown` so the package stays runtime-agnostic; cast it when you need the specifics:
	 * `(ctx.server as import('bun').Server).publish(...)`.
	 */
	server: unknown;
	dev: boolean;
};

/**
 * Default `checkOrigin`: same-origin only. A browser sends `Origin` on every WebSocket
 * handshake, same-origin or not, so comparing it against the request's own `Host` is a
 * safe default whether or not `upgrade` relies on cookies — it's the standard mitigation
 * for cross-site WebSocket hijacking (CSWSH). A request with no `Origin` header (curl,
 * wscat, a server-to-server client) is let through, since only a browser sends one.
 *
 * It guards against other sites, not against other clients: it is no authentication, and a
 * proxy that rewrites `Host` needs to pass the public one on (or a `checkOrigin` of your own).
 */
export function sameOriginCheck(origin: string | null, ctx: UpgradeContext): boolean {
	if (!origin) return true;
	const host = ctx.request.headers.get('host');
	if (!host) return false;
	try {
		const from = new URL(origin);
		// parsed the same way as the origin, so case and a default port (`:443`) don't matter
		return from.host === new URL(`${from.protocol}//${host}`).host;
	} catch {
		return false; // malformed Origin or Host header — fail closed
	}
}

/**
 * Guard rails for a single connection. Every one has a working default — override the ones
 * your workload needs, in `socket.config.ts`:
 *
 * ```ts
 * export default defineSocketServer({
 *   limits: { maxOperations: 64, maxPayloadBytes: 256 * 1024 }
 * });
 * ```
 */
export type SocketLimits = {
	/**
	 * Largest frame accepted from a client, in bytes. Oversized frames close the connection
	 * (`1009`). Also applied to the transport where it supports it.
	 * @default 1048576 (1 MB)
	 */
	maxPayloadBytes: number;
	/**
	 * How many operations (live streams plus in-flight mutations) one connection may hold.
	 * Past the limit new operations fail instead of piling up.
	 * @default 256
	 */
	maxOperations: number;
	/**
	 * Bytes a slow client may have buffered before a stream stops producing. The stream
	 * resumes once the socket drains, so a slow reader gets slow updates rather than the
	 * server growing without bound. Mutation results wait the same way. Replies that can't
	 * wait (errors, keepalive) have a budget of the same size on a congested socket: a
	 * client that keeps sending requests past it without reading is closed with `1011`,
	 * whatever `onBackpressure` says.
	 * @default 1048576 (1 MB)
	 */
	maxBufferedBytes: number;
	/**
	 * What to do when a connection stays over `maxBufferedBytes` for `backpressureTimeoutMs`
	 * — either drop the connection (`1011`) or keep waiting forever.
	 * @default 'close'
	 */
	onBackpressure: 'close' | 'wait';
	/**
	 * How long a stream waits for a congested socket before `onBackpressure` applies.
	 * @default 30000
	 */
	backpressureTimeoutMs: number;
	/**
	 * Values a pub/sub subscriber may queue before the oldest are dropped. Guards against a
	 * fast publisher feeding a slow consumer.
	 * @default 1024
	 */
	maxQueuedMessages: number;
};

export const DEFAULT_LIMITS: SocketLimits = {
	maxPayloadBytes: 1024 * 1024,
	maxOperations: 256,
	maxBufferedBytes: 1024 * 1024,
	onBackpressure: 'close',
	backpressureTimeoutMs: 30_000,
	maxQueuedMessages: 1024
};

/** Context handed to the `handleError` hook. */
export type SocketErrorContext = {
	/** The upgrade request the failing operation belongs to. */
	request: Request;
	/** Data attached by the `upgrade` hook. */
	data: Record<string, unknown>;
	/** Module id and export name of the failing operation, when it got that far. */
	operation?: { module: string; export: string; kind: 'stream' | 'mutate' };
};

export type SocketServerHooks = {
	/**
	 * Runs once at server start, before the server begins accepting traffic — connect to
	 * databases, swap the pub/sub engine, warm caches. May return a cleanup callback that
	 * runs on graceful shutdown.
	 */
	init?(ctx: SocketServerContext): void | InitCleanup | Promise<void | InitCleanup>;

	/**
	 * Validates the `Origin` header before `upgrade` runs. Defaults to {@link sameOriginCheck}
	 * — reject with `403` when a browser's `Origin` doesn't match the request's `Host`.
	 * Override for a different policy (an allowlist for a separate frontend origin), or pass
	 * `() => true` to disable the check for non-browser clients behind their own auth.
	 */
	checkOrigin?(origin: string | null, ctx: UpgradeContext): boolean | Promise<boolean>;

	/**
	 * Intercept every WebSocket upgrade: authenticate, read/set cookies and headers, attach
	 * per-connection data (available as `ctx.data` in `stream`/`mutate` handlers).
	 */
	upgrade?(ctx: UpgradeContext): UpgradeResult | Promise<UpgradeResult>;

	/**
	 * Wrap or extend the WebSocket handler (tune Bun options such as `maxPayloadLength`,
	 * observe `open`/`close`, …). Applied by both adapters and — for the lifecycle
	 * callbacks — in dev.
	 */
	websocket?(handler: SocketWebSocketHandler): SocketWebSocketHandler;

	/** Per-connection guard rails; anything omitted keeps its default. */
	limits?: Partial<SocketLimits>;

	/**
	 * Called for every error a `stream`/`mutate` handler throws — your logging hook, and the
	 * SvelteKit `handleError` analogue.
	 *
	 * Unexpected errors never reach the client verbatim (they would leak connection strings,
	 * paths, SQL); the client gets a generic message. Return `Issue[]` to say something more
	 * useful instead.
	 */
	handleError?(error: unknown, ctx: SocketErrorContext): Issue[] | void;
};

/** A config module's default export: a hooks object, or a function of `{ dev }` returning one. */
export type SocketServerConfig =
	| SocketServerHooks
	| ((ctx: SocketServerContext) => SocketServerHooks | Promise<SocketServerHooks>);

/**
 * Identity helper for typed `socket.config.ts` files. Generic on purpose: it hands the
 * exact shape back, so {@link InferSocketData} can read what your `upgrade` hook returns.
 */
export function defineSocketServer<const Config extends SocketServerConfig>(
	config: Config
): Config {
	return config;
}

/** The hooks object of a config, whether it was written as one or as a function. */
type HooksOf<Config> = Config extends (ctx: never) => infer Hooks ? Awaited<Hooks> : Config;

/**
 * The per-connection data a config's `upgrade` hook attaches — use it to type `ctx.data`
 * across the app in one line:
 *
 * ```ts
 * declare module 'svelte-ws' {
 *   interface SocketData extends InferSocketData<typeof socketConfig> {}
 * }
 * ```
 *
 * Falls back to an open record for configs without an `upgrade` hook.
 */
export type InferSocketData<Config> =
	HooksOf<Config> extends { upgrade?: infer Upgrade }
		? Upgrade extends (...args: never) => infer Result
			? OrOpen<NonNullable<Extract<Awaited<Result>, { data?: unknown }>['data']>>
			: Record<string, unknown>
		: Record<string, unknown>;

/** An `upgrade` hook that never returns `data` leaves it an open record, not `never`. */
type OrOpen<T> = [T] extends [never] ? Record<string, unknown> : T;

/** Normalise a config module's default export into a hooks object. */
export async function resolveHooks(
	config: SocketServerConfig | null | undefined,
	ctx: SocketServerContext
): Promise<SocketServerHooks> {
	if (!config) return {};
	return typeof config === 'function' ? await config(ctx) : config;
}
