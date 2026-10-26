# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's advisory form](https://github.com/krowten/svelte-ws/security/advisories/new)
rather than in a public issue. Include what you did, what happened, and the version you
were running.

## Supported versions

The package is pre-1.0. Fixes land on the latest release; older versions are not patched.

## What this library exposes

Two things are worth knowing when you assess your own app:

**Every export of a `*.socket.ts` file is a public endpoint.** The client names a module
and an export, and the server runs it. Which component imports it, and whether that page is
reachable in your UI, makes no difference. Authorisation belongs in the handler or in the
`upgrade` hook. This mirrors SvelteKit's remote functions and is documented on the
[streams page](https://krowten.github.io/svelte-ws/streams).

**Errors are redacted by default.** Validation failures and messages raised with
`socketError(...)` reach the client verbatim. Everything else becomes `"Internal Error"`,
because a stray `Error` may carry a connection string or a filesystem path. Under
`vite dev` the real message is shown instead. The original always reaches your
`handleError` hook.

Connections also run under limits with working defaults: frame size, concurrent operations
per connection, buffered bytes before a stream pauses, and pub/sub queue depth. See
[socket.config.ts](https://krowten.github.io/svelte-ws/server-config).
