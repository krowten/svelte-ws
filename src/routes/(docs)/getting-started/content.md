# Add WebSockets to SvelteKit

To add WebSockets to a SvelteKit app, install svelte-ws, put one of its adapters in
`vite.config.ts`, and export `stream()` and `mutate()` from a `*.socket.ts` file. The
dev server serves the WebSocket endpoint itself, so there is no second process to run and
nothing to add to `hooks.server.ts`. It needs SvelteKit 3.

## Set up with the Svelte CLI

In an existing SvelteKit 3 project, one command does the setup below:

```bash
npx sv add svelte-ws   # or: bunx sv add svelte-ws / pnpm dlx sv add svelte-ws
```

It asks which runtime will serve the app and whether to add a demo page, then:

- adds `svelte-ws` to `dependencies`;
- points the adapter in `vite.config.ts` at `svelte-ws/adapter-node` or `svelte-ws/adapter-bun`
  and removes the old adapter package. Moving from `@sveltejs/adapter-node` or
  `@sveltejs/adapter-bun` keeps the adapter's options; from any other adapter it starts
  from the defaults;
- with Bun, changes the `build` script to `bun --bun vite build` (see [Run it](#run-it));
- with the demo, adds a message board at `src/routes/socket` that every open tab shares
  through `publish` and `subscribe`, plus `valibot` to validate what gets posted.

To skip the prompts, pass the answers inline:
`npx sv add svelte-ws=adapter:bun+demo:no`. The sections below are the same setup done by
hand.

## Install

```bash
bun add svelte-ws   # or: npm i svelte-ws / pnpm add svelte-ws
```

The package brings the definers, the pub/sub bus, the Vite plugin and both adapters. Its
own dependencies are two small ones: `ws` (the Node transport) and the Standard Schema
types. No broker or extra service is needed.

## Wire up Vite

Pick a svelte-ws adapter in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from 'svelte-ws/adapter-node'; // or 'svelte-ws/adapter-bun'

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter()
		})
	]
});
```

That's the whole wiring: the adapter brings its own Vite plugin, and there are no
`hooks.server.ts` changes and no special dev runtime. In `vite dev` the plugin serves the
WebSocket endpoint on the dev server itself, same origin, and in production the adapter
serves it. Both adapters are SvelteKit's official ones with the WebSocket added. `adapter-node` goes through the `ws`
package, `adapter-bun` through native Bun WebSockets. Your application code is the same
either way; see [adapters](/adapter) for how to choose.

## Write your first socket module

Create a `*.socket.ts` file next to the components that use it:

```ts
// src/routes/ticker/ticker.socket.ts
import { stream } from 'svelte-ws';

export const clock = stream(async function* (_args, ctx) {
	while (!ctx.signal.aborted) {
		yield new Date().toISOString();
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
});
```

Use it from a component:

```svelte
<script>
	import { clock } from './ticker.socket';

	const time = clock();
</script>

<time>{time.current ?? '…'}</time>
```

Every subscriber with the same arguments shares one server stream, and the stream is
released when the last component using it is destroyed.

## Run it

`vite dev` serves the WebSocket endpoint on the dev server, whichever adapter you picked.
The production build differs: `adapter-bun` calls Bun's own build API, so `vite build` has
to run inside Bun. Put the `--bun` flag in the script once and `bun run build` works as
usual. In `package.json`, with adapter-bun:

```json
"scripts": {
	"dev": "vite dev",
	"build": "bun --bun vite build",
	"start": "bun ./build"
}
```

With adapter-node:

```json
"scripts": {
	"dev": "vite dev",
	"build": "vite build",
	"start": "node build"
}
```

Without the flag, `bun run build` starts Vite under Node (its CLI declares
`#!/usr/bin/env node`) and adapter-bun stops with "adapter-bun requires running the
SvelteKit build with Bun". Only the build needs Bun; `vite dev` works either way.

## Next steps

- [Streams & mutations](/streams): the full authoring API
- [The pub/sub bus](/pubsub): fan-out between transports
- [socket.config.ts](/server-config): startup code, auth at upgrade, limits
- [Testing](/testing): drive socket modules in unit tests without a server
