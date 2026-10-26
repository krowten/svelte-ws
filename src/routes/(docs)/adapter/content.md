# Adapters

svelte-ws ships two SvelteKit adapters, `svelte-ws/adapter-node` and `svelte-ws/adapter-bun`.
Each is SvelteKit's official adapter with a WebSocket endpoint added: `adapter-node` wraps
[`@sveltejs/adapter-node`](https://svelte.dev/docs/kit/adapter-node) unchanged, and
`adapter-bun` is a fork of [`@sveltejs/adapter-bun`](https://svelte.dev/docs/kit/adapter-bun)
that differs only where it hands `Bun.serve()` a `websocket` handler. Static files,
environment variables, `paths.origin`, proxy headers and graceful shutdown are the official
code, so the official documentation for each adapter applies as written.

```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from 'svelte-ws/adapter-node'; // or 'svelte-ws/adapter-bun'

export default defineConfig({
	plugins: [sveltekit({ adapter: adapter() })]
});
```

The adapter adds the `sveltekitSocket()` Vite plugin itself, in dev and in the build. Plugin options go to the adapter as `socket`, for example
`adapter({ socket: { config: './server/socket.config.ts' } })`.

## Choosing one

Take `adapter-node` unless you have a reason not to. It runs anywhere Node runs, which is
most hosts, most Docker images and most CI. Take `adapter-bun` when you already deploy on
Bun: WebSockets are native there, static files are served as native Bun routes, and the
build can compile into a single executable.

|                   | `svelte-ws/adapter-bun`                                     | `svelte-ws/adapter-node`                                      |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| built on          | a fork of `@sveltejs/adapter-bun` 1.0                       | `@sveltejs/adapter-node` 6                                    |
| WebSockets        | native Bun                                                  | the `ws` package, on adapter-node's HTTP server               |
| build with        | `bun --bun vite build` (the adapter calls Bun's build API)  | `vite build`                                                  |
| run with          | `bun ./build`                                               | `node build`                                                  |
| options, env vars | [adapter-bun docs](https://svelte.dev/docs/kit/adapter-bun) | [adapter-node docs](https://svelte.dev/docs/kit/adapter-node) |
| minimum runtime   | Bun 1.4                                                     | Node 22.17                                                    |

Nothing in your application code changes between them: `*.socket.ts` files,
`socket.config.ts` and the pub/sub bus are identical. A project can pick its target from
the environment:

```ts
import bun from 'svelte-ws/adapter-bun';
import node from 'svelte-ws/adapter-node';

const adapter = process.env.ADAPTER === 'bun' ? bun : node;
```

## Building with adapter-bun

The official adapter-bun bundles the server with `Bun.build()`, so the build itself has to
run in Bun, not only the server. `bun run build` is not enough on its own: Vite's CLI
declares `#!/usr/bin/env node`, and Bun honours that unless told otherwise. Put the flag in
the script:

```json
"scripts": {
	"build": "bun --bun vite build"
}
```

Without it the build stops with "adapter-bun requires running the SvelteKit build with
Bun". `vite dev` is unaffected: the dev server and its WebSocket endpoint work under Node
and under Bun alike.

## Options and environment variables

Each adapter takes its official counterpart's options (`out`, `precompress`, `envPrefix`,
and on Bun `serverOptions` and `buildOptions`) plus `socket`. Note the defaults differ:
adapter-node precompresses assets unless told not to, adapter-bun only when you set
`precompress: true`.

The environment variables are the official ones too: `PORT`, `HOST`, `SOCKET_PATH`,
`BODY_SIZE_LIMIT`, `PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER`, `XFF_DEPTH`,
`SHUTDOWN_TIMEOUT` and the rest, as documented for each adapter. The public origin comes
from [`paths.origin`](https://svelte.dev/docs/kit/@sveltejs-kit-vite#paths) in your
config, which both official adapters use instead of an `ORIGIN` variable.

## WebSockets on Bun and on Node

Both adapters handle the upgrade before SvelteKit sees the request. On a WebSocket request
to the endpoint they check the `Origin` header, run your [`upgrade` hook](/server-config),
then hand the connection to the same handler: Bun through `server.upgrade()` in front of
the adapter's own request handler, Node through the `ws` package on the HTTP server that
adapter-node's `build/index.js` exports. SvelteKit hooks are not involved, which is what
lets the identical code path run under `vite dev`, where there is no production server.

`socket.config.ts`'s `init` runs before the server starts listening.

## Graceful shutdown

Shutdown is the official adapters' own: on `SIGINT`/`SIGTERM` they stop accepting
connections, wait for in-flight requests for up to `SHUTDOWN_TIMEOUT` seconds and emit
`sveltekit:shutdown`. svelte-ws adds one step at the start: live WebSocket connections are
closed with code `1001`, so clients know it was intentional and the drain is not held open
by sockets that would never finish on their own. The cleanup function returned from `init`
runs on `sveltekit:shutdown`.

```ts
process.on('sveltekit:shutdown', async (reason) => {
	await flushLogs(reason); // 'SIGINT' | 'SIGTERM'
});
```

## Why the Bun adapter is a fork

`@sveltejs/adapter-bun` calls `Bun.serve()` itself and has no option for a `websocket`
handler, so the only way to add one is inside its server code. svelte-ws keeps an
otherwise untouched copy of the published package and inserts three marked lines: one
import, the call that installs the WebSocket endpoint, and the socket close at shutdown.
Everything else is upstream's, and new upstream releases are merged by diffing (the
procedure is in `src/lib/socket/adapter/bun/UPSTREAM.md` in the repository). If upstream
gains a way to add a `websocket` handler, the fork goes away and `adapter-bun` becomes a
wrapper like `adapter-node`.

## Other runtimes

The transport core is runtime-agnostic. A `SocketConnection` only needs `{ send, close }`
plus incoming frames, which is why `vite dev`, Bun and Node all run the same code: Bun
passes the handler from `createWebSocketHandler({ resolve })` to `Bun.serve({ websocket })`,
Node and the dev server drive it through `attachNodeWebSocket()`, a small façade over the
`ws` package. Runtimes with a different execution model need more than a port. On
Cloudflare, for instance, connections must live in a Durable Object, and hibernation resets
in-memory state, which is incompatible with holding a live async generator per stream.
