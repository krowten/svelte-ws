# SvelteKit realtime: WebSocket, SSE, Socket.IO and the alternatives

If updates only flow from the server to the browser, use SvelteKit's `query.live`: it streams over
plain HTTP and needs no extra server. If clients also send messages often, or you want one
connection for the whole app with resumable streams and pub/sub, you want WebSockets. As of October
2026 SvelteKit has no built-in WebSocket support, so you pick a library. svelte-ws is one that keeps
the remote functions style: `stream()` and `mutate()` in `*.socket.ts` files, served over a single
multiplexed WebSocket by a Bun or Node adapter.

This page compares the options people usually weigh against each other. Everything said about
another project comes from that project's own README or documentation, read in October 2026.
A dash in the table means the project's docs say nothing on that point, which is not the same as
the feature being absent.

## At a glance

|                            | svelte-ws                                      | `query.live` (SvelteKit)                                   | `sveltekit-sse`                              | Socket.IO                                                                     | svelte-realtime                                                    | Hand-rolled `ws` / Bun hook                         |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| Transport                  | WebSocket                                      | HTTP response, `text/event-stream`                         | Server-sent events                           | Engine.IO: HTTP long-polling, WebSocket or WebTransport                       | WebSocket on uWebSockets.js                                        | WebSocket                                           |
| Direction                  | Both                                           | Server to client; writes go through `command` over HTTP    | Server to client                             | Both                                                                          | Both                                                               | Both                                                |
| Authoring model            | `*.socket.ts`, schema-validated, typed client  | `*.remote.ts`, same model as `query`                       | A `+server` route and a store                | `emit` / `on` event handlers                                                  | `src/live/*.js`, `live()` and `live.stream()`, store on the client | Whatever you write                                  |
| Works in `vite dev` as is  | Yes                                            | Yes (part of SvelteKit)                                    | Yes (a `+server` route)                      | Needs wiring; no SvelteKit guide                                              | Yes (adapter plugin)                                               | You write a Vite plugin                             |
| One connection for the app | Yes                                            | Instances of the same query share a connection             | —                                            | —                                                                             | —                                                                  | Yours                                               |
| Reconnect                  | Backoff, re-subscribes streams                 | Backoff, plus on `navigator.onLine`                        | `onclose` callback; you call `connect` again | Built in; opt-in connection state recovery                                    | Reconnect with delta sync and replay per stream                    | Yours                                               |
| Resume after a gap         | Opt-in per stream (`cursor`, `ctx.since`)      | —                                                          | —                                            | Opt-in; "will not always be successful"                                       | Opt-in delta sync                                                  | Yours                                               |
| Pub/sub and scaling        | Built-in bus, Redis engine, no sticky sessions | Bring your own bus (svelte-ws's bus can feed it)           | —                                            | Adapters (Redis, Postgres, Mongo and more); sticky sessions with long-polling | Redis, Postgres NOTIFY and clustering sections in the README       | Yours                                               |
| Testing without a server   | `svelte-ws/testing`, in memory                 | —                                                          | —                                            | —                                                                             | `createTestEnv()` from `svelte-realtime/test`                      | Yours                                               |
| Runtimes                   | Bun 1.4+ or Node 22.17+ (official adapters)    | Wherever SvelteKit runs                                    | Wherever SvelteKit runs                      | Node server; also Deno, Java, Python, Go, Rust servers                        | Node 22+ with a native addon; SvelteKit 2 only for now             | Node, or Bun through a community adapter            |
| Maturity (October 2026)    | 0.1.x                                          | Part of SvelteKit; remote functions are still experimental | 456 stars, last push May 2026                | 63k stars, last push September 2026                                           | 149 stars, created March 2026, pushed this month                   | `svelte-adapter-bun`: 662 stars, last push Oct 2025 |

## SSE or WebSocket?

Server-sent events are one-directional: the server pushes, the client listens. In SvelteKit that
case is covered natively. `query.live` takes an async generator, streams its values to the client,
shares one connection between components that use the same query, and reconnects with exponential
backoff. During server-side rendering it returns the first yielded value, so the page arrives with
data. Writes go through a `command`, which is an ordinary HTTP request.

That is enough for dashboards, notifications, progress bars and live feeds where the user rarely
writes. It is also the lowest-friction option: nothing to install, nothing to deploy beside your
app.

Reach for a WebSocket when one of these holds:

- Clients send a steady flow of messages, and an HTTP round-trip per write is too much.
- You want one connection for the whole app, with each stream and mutation multiplexed over it.
- You want to authenticate once at the handshake and have every handler see that identity.
- You need to resume a stream after a disconnect without a hole in the feed.

The two also mix. svelte-ws's [pub/sub bus](/pubsub) is shared by every transport, so an HTTP
`command` can publish and a WebSocket `stream` can observe, or a socket `mutate` can feed a
`query.live`. You do not have to choose once for the whole app.

tRPC draws the same line. Its subscriptions can run over either `wsLink` or an SSE-based
`httpSubscriptionLink`, and its docs recommend SSE when you are unsure, because it is easier to set
up and needs no WebSocket server. `sveltekit-sse` is the SSE option for projects that do not use
remote functions: you return `produce(...)` from a `+server` route and read it with `source(...)`
on the client.

See also [Why not SSE / query.live?](/introduction) for the short version.

## Socket.IO in SvelteKit

Socket.IO is not a WebSocket implementation. Its documentation says so directly: it adds metadata
to every packet, so a plain WebSocket client cannot connect to a Socket.IO server and the reverse.
Underneath it runs Engine.IO, which starts on HTTP long-polling or upgrades to WebSocket, and can
use WebTransport. In return you get rooms, acknowledgements, automatic reconnection, an opt-in
connection state recovery feature, a family of adapters for scaling across servers, and server and
client implementations in several languages.

Using it in SvelteKit means attaching it to the HTTP server yourself, because SvelteKit does not
expose one. Socket.IO's own how-to guides cover Next.js, Nuxt, React and Vue, but not SvelteKit. The Nuxt guide hooks the Socket.IO server into Nitro's request
handling; SvelteKit has no equivalent hook. In practice that means two pieces: a Vite plugin that
attaches to the dev server's HTTP server (the technique used in the SvelteKit WebSocket issue
thread for `ws`), and in production a custom Node server that imports `handler.js` from
`adapter-node`, which SvelteKit documents for use with Express, Connect, Polka or `http.createServer`.
What Socket.IO does not give you is anything shaped like SvelteKit: your handlers are event
listeners rather than files in `src/routes`, and validation, types and testing are yours to
arrange. If you need a long-polling fallback, clients that are not JavaScript, or its adapter
ecosystem, that trade is reasonable. If your clients are browsers running your own SvelteKit app,
a plain WebSocket with a typed layer on top is less to carry.

## svelte-realtime

[`svelte-realtime`](https://github.com/lanteanio/svelte-realtime) is the closest project in spirit
to svelte-ws: "realtime RPC and reactive subscriptions for SvelteKit". You write server functions
in `src/live/*.js`, mark them with `live()` or `live.stream()`, import them from `$live/...`, and a
Vite plugin turns the imports into client stubs. Streams arrive as Svelte stores and merge live
events with strategies such as `crud`. It has a long feature list: optimistic updates, an offline
queue, delta sync, rate limiting, cron, presence and cursors, a Redis-backed multi-instance mode and
a `createTestEnv()` helper.

The differences are in the foundation:

- **Server.** It is built on [`svelte-adapter-uws`](https://github.com/lanteanio/svelte-adapter-uws),
  which runs your app on uWebSockets.js, a native C++ addon installed from GitHub rather than npm.
  The adapter's README asks for Node 22+, and for Docker a glibc 2.38+ image such as
  `node:22-trixie-slim`; Alpine and Bookworm-based images will not work. svelte-ws runs on Bun or
  Node with the `ws` package and no native addon.
- **Setup.** It needs the adapter, two Vite plugins, and a `src/hooks.ws.js` file whose `message`
  hook routes incoming frames. svelte-ws needs one Vite plugin and an adapter; no hooks file.
- **SvelteKit version.** Its README states that it and `svelte-adapter-uws` do not support
  SvelteKit 3 yet. svelte-ws is built for SvelteKit 3.
- **Shape.** Its client side is store-based (`$messages`) and its examples are JavaScript, while
  svelte-ws returns a reactive handle with `.current`, `.status` and `.error`, and validates
  arguments against any Standard Schema library.
  If you are on SvelteKit 2, want uWebSockets.js, and want its built-in extras rather than a smaller
  core, it is worth a look. The project is young (created in March 2026) but actively developed.

## svelte-adapter-bun and hand-rolled `ws`

The minimal route is a WebSocket server and nothing else. There are two ways to get one.

**A server hook.** The community [`svelte-adapter-bun`](https://github.com/gornostay25/svelte-adapter-bun)
lets you export a `websocket` handler from `hooks.server.ts`, and in `handle` you call
`event.platform.server.upgrade(...)` for the paths you choose. You get Bun's native WebSocket and
a handful of lines of code. You do not get a message format, validation, subscriptions, a client,
reconnection, pub/sub or a way to test any of it. Its last push was in October 2025.
SvelteKit 3 also has an official `@sveltejs/adapter-bun` (1.0.0). Its documentation says the
generated server owns `fetch` and `routes` and does not expose `websocket`, so this recipe does not
carry over to it.
**A `ws` server beside SvelteKit.** The usual recipe from the SvelteKit WebSocket issue is a Vite
plugin that creates a `WebSocketServer` on the dev server's `httpServer`, plus a custom Node server
for production. Commenters there note the cost: the socket code lives outside SvelteKit's module
graph, so `$lib` aliases and `$env` do not work in it unless you set that up yourself.

This is a fine choice when you need one or two simple channels and want full control. As soon as
you need validation, reconnection, per-stream subscriptions and tests, you are rebuilding what
the libraries above already ship. svelte-ws's adapters cover the production side
(see [adapters](/adapter)); `svelte-ws/testing` covers the test side (see [testing](/testing)).

## Native WebSocket support in SvelteKit

SvelteKit has no built-in WebSocket support today. The request is [sveltejs/kit#1491](https://github.com/sveltejs/kit/issues/1491),
"Native support for web sockets", open since May 2021 and labelled `p1-important`.

What happened since:

- In 2024 the team added a `supports` feature to the adapter API so adapters can declare optional
  capabilities, with WebSockets named as a possible use.
- In early 2025 a pull request, [#12973](https://github.com/sveltejs/kit/pull/12973), implemented
  WebSockets on top of `crossws`, with `socket` handlers exported from `+server.js`. It was
  published for testing through `pkg.pr.new`.
- On 5 February 2026 a maintainer closed that pull request without merging it, saying the team had
  "a much more streamlined design in mind". On 6 July 2026 a maintainer wrote that the team was
  focused on SvelteKit 3 and would revisit WebSockets afterwards.
- SvelteKit 3.0.0 was released on 1 October 2026. Its release notes mention no WebSocket
  feature, and neither does any other release note in the repository. The new official Bun adapter documents that
  it does not expose a `websocket` option.

So the state is: not built in, not experimental, no public API to build on, and the issue is still
open. The last comment in the issue thread is a bump from July 2026.
How svelte-ws relates: it does not depend on that feature or imitate the API from the closed pull
request. The Vite plugin serves the WebSocket endpoint on the dev server itself, and the
[adapters](/adapter) handle the upgrade before SvelteKit sees the request, so SvelteKit hooks are
not involved.

## When svelte-ws is not the right choice

- **Updates only flow one way.** Use `query.live`. It is built in, needs no adapter and works
  wherever your app already runs. Add svelte-ws later if you need the other direction.
- **You deploy to serverless or edge platforms.** svelte-ws ships standalone Bun and Node servers
  only. A platform that cannot keep a long-running process with open sockets is out of scope, and
  Cloudflare in particular needs connections to live in a Durable Object, where hibernation resets
  in-memory state, which does not fit a live async generator per stream. See [adapters](/adapter).
- **You need clients that are not browsers running JavaScript, or a long-polling fallback.** Socket.IO
  covers both. svelte-ws speaks its own graphql-ws-style protocol over WebSocket only.
- **You want uWebSockets.js or the larger feature set of svelte-realtime**, and you are on
  SvelteKit 2.
- **You need a 1.0 API today.** svelte-ws is 0.1.x and not yet published on npm.

If none of those apply, start with [getting started](/getting-started), and read
[streams & mutations](/streams) for the authoring API and [testing](/testing) for how socket
modules are tested.
