/**
 * Fuzz test of one server connection driven by a hostile or broken client: random frames from
 * the protocol's grammar and outside it (garbage, reused and invalid ids, unknown targets,
 * operations before the handshake, oversized frames, a `since` on any stream), interleaved
 * with publishes and the socket going away. The real client never sends most of this, so the
 * whole-stack fuzz in `fuzz.svelte.spec.ts` can't reach it.
 *
 * Replay a failure with the seed and run from its message:
 * FUZZ_SEED=<seed> bun run test:unit -- --run connection.fuzz -t 'run <run> '
 *
 * What must hold whatever the client sends:
 * - `handleMessage` never throws or rejects, and nothing is left unhandled.
 * - Every frame the server sends is well-formed and answers an id the client used.
 * - No handler starts before `connection_init`, and no more than `maxOperations` run at once.
 * - `since` only reaches a stream that declares a cursor.
 * - A handler's own error message never crosses the wire (it's redacted).
 * - After the socket goes away nothing more is sent, and every handler has finished.
 * - The server only closes the connection for an oversized frame (1009) or an operation id
 *   that is still in use (4409); after that the client connects again and the run goes on.
 */
import type { AnyDescriptor } from '../types.js';
import type { ConnectionSocket } from './connection.js';

import { afterAll, beforeAll, expect, inject, test, vi } from 'vitest';
import * as v from 'valibot';
import { createInMemoryPubSub } from '../pubsub.js';
import { CLOSE_DUPLICATE_ID } from '../protocol.js';
import { createSocketConnection, type SocketConnection } from './connection.js';
import { mutate, stream } from './define.js';

const fuzz = inject('fuzz');
const { seed } = fuzz;
// this one runs in milliseconds, so it gets ten times the runs of the whole-stack fuzz
const runs = fuzz.runs * 10;
const steps = Math.round(fuzz.steps * 1.5);

const MAX_OPERATIONS = 3;
const MAX_PAYLOAD_BYTES = 2048;
const SECRET = 'do-not-leak';
const SERVER_TYPES = new Set([
	'connection_ack',
	'ping',
	'pong',
	'next',
	'complete',
	'error',
	'result'
]);

/** mulberry32: tiny seeded PRNG, so a failing sequence can be replayed exactly. */
const mulberry32 = (a: number) => () => {
	a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const problems: string[] = [];
const onRejection = (reason: unknown) => problems.push(`unhandled rejection: ${String(reason)}`);

beforeAll(() => {
	process.on('unhandledRejection', onRejection);
	vi.spyOn(console, 'error').mockImplementation((...args) =>
		problems.push(`console.error: ${args.join(' ')}`)
	);
});

afterAll(() => {
	process.off('unhandledRejection', onRejection);
	vi.restoreAllMocks();
});

type Session = {
	conn: SocketConnection;
	/** Closed by the server, or the socket went away. */
	gone: boolean;
	initialized: boolean;
	running: { now: number; max: number };
	slow: Array<() => void>;
	closes: Array<number | undefined>;
};

/** Let every frame and handler that is due run to completion. */
const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

for (let run = 0; run < runs; run++) {
	test(`connection fuzz run ${run} (seed ${seed})`, async () => {
		const rand = mulberry32(seed + run * 1_000_003);
		const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

		const engine = createInMemoryPubSub();
		const sessions: Session[] = [];
		let started = 0;
		let sentAfterGone = 0;
		const sent: string[] = [];

		/**
		 * One connection. A server that closes it (a reused id, an oversized frame) or a socket
		 * that goes away ends the session, and the client simply connects again.
		 */
		const connect = (): Session => {
			const session: Session = {
				gone: false,
				initialized: false,
				running: { now: 0, max: 0 },
				slow: [],
				closes: [],
				conn: undefined as never
			};
			const { running, slow } = session;

			/** Count a handler in and out, so the cap and the cleanup can be checked. */
			const enter = (what: string) => {
				if (!session.initialized) problems.push(`${what} started before connection_init`);
				started++;
				running.max = Math.max(running.max, ++running.now);
			};
			const leave = () => running.now--;

			const descriptors: Record<string, AnyDescriptor> = {
				feed: stream(v.object({ ch: v.string() }), async function* ({ ch }, ctx) {
					enter('feed');
					if (ctx.since !== undefined) problems.push('since reached a stream without a cursor');
					try {
						yield* engine.subscribe<number>(ch, { signal: ctx.signal });
					} finally {
						leave();
					}
				}),
				resumable: stream(
					v.object({ ch: v.string() }),
					async function* ({ ch }, ctx) {
						enter('resumable');
						try {
							if (ctx.since !== undefined) yield 0;
							yield* engine.subscribe<number>(ch, { signal: ctx.signal });
						} finally {
							leave();
						}
					},
					{ cursor: (value: number) => value }
				),
				finite: stream(async function* () {
					enter('finite');
					try {
						yield 1;
						yield 2;
					} finally {
						leave();
					}
				}),
				crash: stream(async function* () {
					enter('crash');
					try {
						yield 1;
						throw new Error(SECRET);
					} finally {
						leave();
					}
				}),
				send: mutate(v.object({ ch: v.string(), value: v.number() }), async ({ ch, value }) => {
					enter('send');
					try {
						await engine.publish(ch, value);
						return value;
					} finally {
						leave();
					}
				}),
				slow: mutate(async () => {
					enter('slow');
					try {
						return await new Promise((resolve) => slow.push(() => resolve('slow')));
					} finally {
						leave();
					}
				}),
				boom: mutate(() => {
					enter('boom');
					try {
						throw new Error(SECRET);
					} finally {
						leave();
					}
				})
			} as unknown as Record<string, AnyDescriptor>;

			const socket: ConnectionSocket = {
				send: (data) => {
					if (session.gone) sentAfterGone++;
					sent.push(data);
				},
				close: (code) => {
					session.closes.push(code);
					session.gone = true;
				}
			};
			session.conn = createSocketConnection({
				socket,
				request: new Request('http://localhost/_events'),
				resolve: (module, name) => (module === 'm.socket.ts' ? descriptors[name] : undefined),
				limits: { maxOperations: MAX_OPERATIONS, maxPayloadBytes: MAX_PAYLOAD_BYTES },
				// the crashing handlers are deliberate; the hook keeps them out of the console
				handleError: () => {}
			});
			sessions.push(session);
			return session;
		};
		let current = connect();

		// ---- the frame grammar ------------------------------------------------------------
		const usedIds = new Set<string>();
		const ID_POOL = ['a', 'b', 'c', 'd', 'e'];
		const id = () => {
			const choice = rand();
			if (choice < 0.85) return pick(ID_POOL);
			return pick([7, '', null, 'x'.repeat(200), {}] as unknown[]);
		};
		const target = () =>
			rand() < 0.85
				? { module: 'm.socket.ts' }
				: pick([{ module: 'nope.socket.ts' }, { module: 42 }, { module: 'm'.repeat(1100) }]);
		const channel = () => pick(['a', 'b']);
		const payloadFor = (name: string) => {
			if (rand() < 0.15) return pick([null, 'x', { ch: 5 }, [1, 2], { value: 'nope' }]);
			if (name === 'send') return { ch: channel(), value: Math.floor(rand() * 100) };
			if (name === 'feed' || name === 'resumable') return { ch: channel() };
			return null;
		};

		const frames: Record<string, () => unknown> = {
			init: () => ({ type: 'connection_init' }),
			stream: () => {
				const name = pick(['feed', 'resumable', 'finite', 'crash', 'send', 'missing']);
				return {
					type: 'stream',
					id: id(),
					...target(),
					export: name,
					payload: payloadFor(name),
					...(rand() < 0.5 ? { since: pick([0, 5, 'x', null]) } : {})
				};
			},
			mutate: () => {
				const name = pick(['send', 'slow', 'boom', 'feed', 'missing']);
				return { type: 'mutate', id: id(), ...target(), export: name, payload: payloadFor(name) };
			},
			complete: () => ({ type: 'complete', id: id() }),
			ping: () => ({ type: 'ping' }),
			pong: () => ({ type: 'pong' }),
			unknown: () => ({ type: pick(['subscribe', 'next', 'result', 42, undefined]), id: id() })
		};
		// operations dominate, so the cap and id reuse actually get exercised
		const FRAME_KINDS = [
			'stream',
			'stream',
			'stream',
			'mutate',
			'mutate',
			'complete',
			'complete',
			'init',
			'ping',
			'pong',
			'unknown'
		];
		const garbage = () =>
			pick([
				'not json',
				'',
				'null',
				'[1,2,3]',
				'{"type":',
				JSON.stringify({ type: 'stream' }),
				new Uint8Array([1, 2, 3]),
				'x'.repeat(MAX_PAYLOAD_BYTES + 1)
			]);

		// ---- run --------------------------------------------------------------------------
		const log: string[] = [];
		for (let n = 1; n <= steps; n++) {
			if (current.gone) {
				log.push(`${n}. client connects again`);
				current = connect();
			}
			const roll = rand();
			if (roll < 0.06 && n > 3) {
				log.push(`${n}. socket closes`);
				current.gone = true;
				current.conn.dispose();
			} else if (roll < 0.14) {
				const ch = channel();
				log.push(`${n}. publish ${ch}`);
				await engine.publish(ch, n);
			} else if (roll < 0.2 && sessions.some((session) => session.slow.length)) {
				log.push(`${n}. answer the slow mutations`);
				for (const session of sessions) for (const resolve of session.slow.splice(0)) resolve();
			} else {
				const raw =
					roll < 0.28
						? garbage()
						: JSON.stringify(n === 1 && rand() < 0.7 ? frames.init() : frames[pick(FRAME_KINDS)]());
				const shown = typeof raw === 'string' ? raw.slice(0, 120) : `<${raw.byteLength} bytes>`;
				log.push(`${n}. client sends ${shown}`);
				if (typeof raw === 'string') {
					const parsed = (() => {
						try {
							return JSON.parse(raw) as { type?: unknown; id?: unknown };
						} catch {
							return null;
						}
					})();
					if (parsed?.type === 'connection_init' && !current.gone) current.initialized = true;
					// only a usable id may ever be answered: 1–128 characters
					if (typeof parsed?.id === 'string' && parsed.id.length > 0 && parsed.id.length <= 128) {
						usedIds.add(parsed.id);
					}
				}
				await expect(
					current.conn.handleMessage(raw),
					`handleMessage rejected at step ${n}`
				).resolves.toBeUndefined();
				if (typeof raw === 'string' && raw.length > MAX_PAYLOAD_BYTES) {
					expect(current.closes.at(-1), `oversized frame closes with 1009`).toBe(1009);
				}
			}
			await settle();

			const where = `seed ${seed}, run ${run}, step ${n}\n${log.join('\n')}`;
			expect(problems, `problems: ${where}`).toEqual([]);
			expect(sentAfterGone, `frames after the socket went away: ${where}`).toBe(0);
			for (const session of sessions) {
				expect(session.running.max, `handlers above maxOperations: ${where}`).toBeLessThanOrEqual(
					MAX_OPERATIONS
				);
				// a slow mutation keeps awaiting its answer; nothing else may outlive the socket
				if (session.gone) {
					expect(
						session.running.now - session.slow.length,
						`handlers still running after close: ${where}`
					).toBeLessThanOrEqual(0);
				}
				const codes = session.closes.filter((code) => code !== 1009 && code !== CLOSE_DUPLICATE_ID);
				expect(codes, `unexpected close codes: ${where}`).toEqual([]);
			}
			for (const data of sent) {
				expect(data.includes(SECRET), `leaked handler error: ${where}`).toBe(false);
				const frame = JSON.parse(data) as { type: string; id?: unknown };
				expect(SERVER_TYPES.has(frame.type), `unknown frame ${data}: ${where}`).toBe(true);
				if ('id' in frame) {
					expect(
						usedIds.has(frame.id as string),
						`frame for an id never sent ${data}: ${where}`
					).toBe(true);
				}
			}
			sent.length = 0;
		}

		// the socket goes away: whatever was running must wind down
		current.conn.dispose();
		current.gone = true;
		for (const session of sessions) for (const resolve of session.slow.splice(0)) resolve();
		await settle();
		const left = sessions.reduce((sum, session) => sum + session.running.now, 0);
		expect(left, `handlers still running at the end: seed ${seed}, run ${run}`).toBe(0);
		expect(problems, `problems at the end: seed ${seed}, run ${run}`).toEqual([]);
		expect(started + log.length, 'the run did something').toBeGreaterThan(0);
	});
}
