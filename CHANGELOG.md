# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) once the package leaves 0.x.

## Unreleased

- The `sv add svelte-ws` demo is now a message board at `/socket` that every open tab
  shares through `publish` and `subscribe`, instead of a clock at `/ticker`. It adds
  `valibot` to the project if it isn't there yet.

## 0.1.0 - 2026-10-26

First release.

- `stream()` and `mutate()` in `*.socket.ts` files, validated with any Standard Schema
  library and imported by components as typed, reactive handles.
- One multiplexed WebSocket per app, with reconnects that re-subscribe every stream and
  opt-in resume through cursors.
- A pub/sub bus shared by socket handlers, remote functions and `+server.ts`, in memory by
  default, with a pluggable engine for Redis and other brokers.
- `socket.config.ts` for startup code, authentication at the upgrade, Origin checks and
  limits, applied the same way in `vite dev` and in production.
- `svelte-ws/adapter-node` and `svelte-ws/adapter-bun`, SvelteKit's official adapters with the
  WebSocket endpoint added.
- `svelte-ws/testing` to run socket modules over an in-memory connection, without a server.
- `npx sv add svelte-ws`, a Svelte CLI add-on that installs and wires everything up.
