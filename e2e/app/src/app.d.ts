// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

import type { InferSocketData } from 'svelte-ws';
import type socketConfig from '../socket.config.js';

// ctx.data is typed from the upgrade hook of socket.config.ts — no casts, no duplication
declare module 'svelte-ws' {
	// an empty body is how a computed type merges into an interface — the rule below fires
	// on every module augmentation of this shape
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface SocketData extends InferSocketData<typeof socketConfig> {}
}

export {};
