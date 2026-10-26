# Forked `@sveltejs/adapter-bun`

`upstream/` is a copy of the published `@sveltejs/adapter-bun` package, **version 1.0.0**
(MIT, © Svelte contributors, see `upstream/LICENSE`). It is kept as close to the original as
possible so that a new release can be merged by diffing.

The only reason for the fork: upstream's server calls `Bun.serve()` itself and does not let
anything add a `websocket` handler. Everything else (static routes, environment variables,
`paths.origin`, compiled executables, graceful shutdown) is upstream's code.

## Changes against upstream

All of them are in `upstream/src/index.js` and carry a `svelte-ws` comment:

1. `import { installWebSocket } from '../../socket.js';`
2. `const websocket = await installWebSocket(options);` right before `Bun.serve(options)`,
   which adds the WebSocket endpoint.
3. `websocket.close();` at the start of the graceful shutdown drain, so live sockets close
   with 1001 instead of holding `server.stop()` open until `SHUTDOWN_TIMEOUT`.

Nothing else in `upstream/` differs from the npm tarball (its `README.md` is left out: the
package build would compile it as a Svelte page). The adapter's name and the
`sveltekitSocket()` Vite plugin are added from outside, in `../bun.ts`. `upstream/` is
excluded from prettier, eslint and `tsc` so no tool rewrites it.

## Updating to a new upstream release

```sh
mkdir -p .scratch/adapter-bun-next && cd .scratch/adapter-bun-next
npm pack @sveltejs/adapter-bun@<version> && tar -xzf sveltejs-adapter-bun-*.tgz
diff -ru package ../../src/lib/socket/adapter/bun/upstream
```

The diff should show only the three changes above (plus whatever upstream changed). Copy
the new files over, re-apply the three insertions, bump the version at the top of this file,
then run `bun run test:e2e`, which builds and serves the e2e app with this adapter.

If upstream ever exposes a `websocket` option or a hook around `Bun.serve`, drop the fork:
depend on `@sveltejs/adapter-bun` and add the WebSocket the way `../node.ts` does for
`@sveltejs/adapter-node`.
