# svelte-ws

WebSocket remote functions for SvelteKit 3: `*.socket.ts` files export `stream()`/`mutate()`,
served over one multiplexed WebSocket by the Vite dev server and, in production, by two
adapters built on SvelteKit's official ones.

- **Language**: TypeScript · **Package manager**: bun
- `src/lib/socket/`: the library, everything the package ships (`svelte-package` → `dist/`)
- `src/routes/`: the documentation site (static, prerendered). Page content lives in
  `(docs)/<slug>/content.md`, the nav in `src/lib/nav.ts`
- `e2e/`: a fixture app consuming the built package by name, plus a Playwright suite that
  runs against a real Bun server and a real Node server

## Commands

```sh
bun run test:unit -- --run   # vitest (server + browser projects)
bun run test:e2e             # builds dist, then the suite on a Bun AND a Node server
bun run check                # svelte-check
bun run lint                 # prettier + eslint
bun run smoke:pack           # packs the tarball and imports every entry from a temp app
```

Changes to `src/lib/socket` are done when `test:unit`, `check`, `lint` and `test:e2e` pass.
`test:e2e` is the only one that exercises the published shape (`dist` + the exports map), so
don't skip it for packaging-adjacent changes.

## Adapters

- `adapter/node.ts` wraps `@sveltejs/adapter-node`, a regular dependency, and rewrites
  `build/index.js` so the WebSocket attaches to adapter-node's own HTTP server.
- `adapter/bun/upstream/` is a vendored copy of `@sveltejs/adapter-bun`. It differs from the
  published package only in three lines marked `// svelte-ws`. Keep it that way: change
  nothing else there, and leave it out of formatting and linting (excluded on purpose).
  `adapter/bun/UPSTREAM.md` describes how to move it to a new upstream release.
- Building with adapter-bun needs Bun as the runtime (`bun --bun vite build`), because the
  adapter calls Bun's build API. `vite dev` works under either runtime.

## Dependencies

Two packages are held back on purpose. `typescript` stays on 6, since SvelteKit 3.0's sync
step uses the compiler API that TypeScript 7 removed. `@types/node` stays on 22, the oldest
Node in `engines`, so the compiler rejects APIs that Node 22 doesn't have. Update everything
else with `bun update --latest '*' '!typescript' '!@types/node'`.

## Svelte docs

`.claude/settings.json` enables the official `svelte` plugin (marketplace `sveltejs/ai-tools`):
its MCP server serves the Svelte 5 and SvelteKit documentation and `svelte-autofixer`, and its
skills cover writing Svelte code. Run `svelte-autofixer` on Svelte code you write and fix what
it reports until it comes back clean.
