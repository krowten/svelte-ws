# Contributing

Thanks for taking a look. Issues and pull requests are both welcome. Taking part means
following the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```sh
bun install
bun run dev        # the documentation site
```

The library lives in `src/lib/socket`. `src/routes` is the documentation site, and `e2e/`
holds a fixture app that installs the package by name plus the Playwright suite that runs
against both adapters.

## Before you open a pull request

Four checks gate a change to `src/lib/socket`:

```sh
bun run lint
bun run check
bun run test:unit -- --run
bun run test:e2e
```

`test:e2e` is the one that matters most for anything packaging-adjacent: it builds `dist`
and runs the suite against the real published shape, including the `exports` map, on a Bun
server and a Node server. `bun run smoke:pack` goes one step further and installs the
packed tarball into a temporary app.

Playwright's WebKit lanes run in CI. To run them locally, install the system libraries
(`sudo npx playwright install-deps`) and set `E2E_WEBKIT=1`.

## House style

- Prettier and ESLint decide formatting and lint; run `bun run format` rather than arguing
  with them.
- Prefer functions over classes, and `type` over `interface` unless declaration merging is
  the point.
- Import from `'bun'` by name instead of reaching for the `Bun` global.
- Comments explain constraints the code can't show. Skip the ones that narrate what the
  next line does.

## Tests

New behaviour needs a test that fails without it. Unit tests sit next to their subject as
`*.spec.ts`; anything touching the browser goes in a `*.svelte.spec.ts` file so vitest
compiles it with runes. Scenarios that need a real server belong in `e2e/tests`.

## Documentation

Public-facing docs live in `src/routes/(docs)/<slug>/content.md`, with the sidebar, page
titles and meta descriptions in `src/lib/nav.ts`. If a change alters behaviour a user can
observe, the docs change with it in the same pull request.
