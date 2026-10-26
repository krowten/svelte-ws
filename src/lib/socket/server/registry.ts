import type { AnyDescriptor } from '../types.js';

export type ModuleExports = Record<string, unknown>;
export type LoadModule = (moduleId: string) => Promise<ModuleExports>;

/**
 * Build the `resolve(module, export)` function the {@link SocketConnection} needs, on top of
 * a `loadModule` strategy. Production loads from the generated manifest (cached); dev loads
 * through Vite's `ssrLoadModule` (no caching, so HMR is respected).
 */
export function createResolver(loadModule: LoadModule, { cache = true } = {}) {
	const moduleCache = new Map<string, Promise<ModuleExports>>();

	return async function resolve(
		moduleId: string,
		exportName: string
	): Promise<AnyDescriptor | undefined> {
		let pending = cache ? moduleCache.get(moduleId) : undefined;
		if (!pending) {
			pending = loadModule(moduleId);
			if (cache) {
				moduleCache.set(moduleId, pending);
				// a failed import (a transient error in top-level code) shouldn't make the module
				// unreachable until restart: forget it, and the next operation retries
				pending.catch(() => moduleCache.delete(moduleId));
			}
		}
		const mod = await pending;
		const value = mod[exportName];
		return isDescriptor(value) ? value : undefined;
	};
}

function isDescriptor(value: unknown): value is AnyDescriptor {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		((value as AnyDescriptor).kind === 'stream' || (value as AnyDescriptor).kind === 'mutate')
	);
}
