# svelte-ws

[![npm](https://img.shields.io/npm/v/svelte-ws)](https://www.npmjs.com/package/svelte-ws)
[![CI](https://github.com/krowten/svelte-ws/actions/workflows/ci.yml/badge.svg)](https://github.com/krowten/svelte-ws/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/svelte-ws)](LICENSE)

WebSocket remote functions for SvelteKit. Write `*.socket.ts` files with `stream()` and
`mutate()`, the way you write `*.remote.ts` with `query` and `command`, and get realtime data
over one multiplexed WebSocket, in `vite dev` and from a standalone Bun or Node server.
SvelteKit 3, Svelte 5.

Where SvelteKit's own `query.live` streams server-to-client over HTTP, svelte-ws keeps one
WebSocket open in both directions: mutations travel on it too, handlers see per-connection
data from an `upgrade` hook, and a shared pub/sub bus (in-memory or Redis) fans messages out.

📖 **[Documentation](https://krowten.github.io/svelte-ws)**: getting started, streams and
mutations, the pub/sub bus, `socket.config.ts`, adapters, Redis, deployment.

## Quick start

```sh
npx sv add svelte-ws
```

The Svelte CLI installs the package, switches your adapter to a svelte-ws one and can add a
demo page. To set it up by hand instead:

```sh
bun add svelte-ws   # or npm i svelte-ws
```

```ts
// vite.config.ts: the adapter brings the svelte-ws Vite plugin along
import adapter from 'svelte-ws/adapter-node'; // or 'svelte-ws/adapter-bun'

plugins: [sveltekit({ adapter: adapter() })];
```

```ts
// src/routes/chat/chat.socket.ts
import { stream, mutate } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';

export const messages = stream(roomSchema, async function* ({ room }) {
	yield* subscribe(`room:${room}`);
});

export const send = mutate(messageSchema, ({ room, text }) => publish(`room:${room}`, { text }));
```

```svelte
<script>
	import { messages, send } from './chat.socket';

	const feed = messages({ room: 'general' }); // .current / .error / .status / .reconnect()
</script>
```

That is all the wiring there is. You don't touch `hooks.server.ts` and you don't run a
second server: `vite dev` serves the WebSocket endpoint itself, and in production the
adapter serves it.

Socket modules can be tested without a server. `svelte-ws/testing` runs the real connection
in memory, including your schemas and hooks:

```ts
import { createTestClient } from 'svelte-ws/testing';
import * as chat from './chat.socket.js';

const client = createTestClient({ modules: { 'chat.socket.ts': chat } });
await client.mutate('chat.socket.ts', 'send', { room: 'a', text: 'hi' });
```

**Next:** [getting started](https://krowten.github.io/svelte-ws/getting-started) ·
[streams & mutations](https://krowten.github.io/svelte-ws/streams) ·
[socket.config.ts](https://krowten.github.io/svelte-ws/server-config) ·
[adapters](https://krowten.github.io/svelte-ws/adapter) ·
[testing](https://krowten.github.io/svelte-ws/testing)

## How it compares

**Socket.IO** speaks its own protocol over long-polling or WebSocket, and in SvelteKit you
attach it to the HTTP server yourself. svelte-ws stays inside the SvelteKit programming
model: a socket module is a file in your routes, the dev server needs no extra process, and
validation uses the same Standard Schema libraries as the rest of your code.

**Bun and Node adapters**, the official ones included, serve your app but no WebSockets
(`svelte-adapter-bun` gives you a raw hook, and everything above it is yours to build).
svelte-ws's adapters are the official `adapter-node` and `adapter-bun` with the WebSocket
endpoint and the authoring model added.

**SSE (`query.live`, `sveltekit-sse`)** covers server-to-client streaming well. A WebSocket
adds client-to-server messages on the same connection, plus state attached once at the
handshake and visible to every handler.

**svelte-realtime** is the closest in spirit. It runs on uWebSockets.js, a native addon,
and does not support SvelteKit 3 yet; svelte-ws runs on plain Bun or Node with no native
code.

The [comparison page](https://krowten.github.io/svelte-ws/compare) goes through each option
in detail.

## Repository layout

- `src/lib/socket`: the library. Definers, pub/sub bus, client runtime, Vite plugin and the
  adapters: `adapter/node.ts` wraps `@sveltejs/adapter-node`, `adapter/bun/upstream/` is a
  marked-up copy of `@sveltejs/adapter-bun` (see `adapter/bun/UPSTREAM.md`).
- `src/routes`: the documentation site, static and prerendered. Pages live at the site
  root, with content in `<slug>/content.md`.
- `e2e/`: a small SvelteKit fixture that installs the package by name, plus a Playwright
  suite. Every scenario runs twice, against a Bun server and a Node server.

## Commands

```sh
bun run dev        # docs site dev server
bun run build      # docs site → build/ (adapter-static)
bun run test:unit  # vitest (server + browser projects)
bun run test:e2e   # package + the same suite on a Bun server and a Node server
bun run smoke:pack # install the packed tarball into a temp app and import every entry
bun run check      # svelte-check
bun run lint       # prettier + eslint
```

`E2E_WEBKIT=1` adds Safari lanes to `test:e2e`. CI runs them by default; locally WebKit
needs system libraries, which Playwright installs with `sudo npx playwright install-deps`.
