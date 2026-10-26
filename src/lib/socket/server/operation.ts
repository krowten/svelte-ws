import type { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The abort signal of the stream operation currently running, so `subscribe()` can end with
 * the stream without the handler passing `ctx.signal` along. Pinned to globalThis like the
 * pub/sub engine, since in dev the connection and the socket modules load as separate copies
 * of this package. Runtimes without `node:async_hooks` (the browser, in tests) go without.
 */
const SLOT = Symbol.for('svelte-ws.operation');
const globals = globalThis as unknown as Record<symbol, AsyncLocalStorage<AbortSignal> | undefined>;

const hooks = (
	globalThis as { process?: { getBuiltinModule?(id: string): unknown } }
).process?.getBuiltinModule?.('node:async_hooks') as typeof import('node:async_hooks') | undefined;

const storage = hooks ? (globals[SLOT] ??= new hooks.AsyncLocalStorage<AbortSignal>()) : undefined;

/** Run `fn` as the operation `signal` belongs to. */
export function runOperation<T>(signal: AbortSignal, fn: () => T): T {
	return storage ? storage.run(signal, fn) : fn();
}

/** The signal of the stream operation this code runs in, if any. */
export function operationSignal(): AbortSignal | undefined {
	return storage?.getStore();
}
