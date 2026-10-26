# Deployment

Which adapter you built with decides the runtime on the host; everything else on this
page applies to both. The build bundles your `devDependencies` into the output and leaves
`dependencies` external, so a host needs `build/`, `package.json` and the production
`node_modules`.

```bash
bun --bun vite build && PORT=3000 bun ./build   # adapter-bun: the build runs in Bun
vite build && PORT=3000 node build              # adapter-node
```

With adapter-bun, keep the `--bun` flag in your `build` script (see
[Getting started](/getting-started#run-it)) so `bun run build` does the right thing locally,
in CI and in Docker alike.

Both adapters are SvelteKit's official ones underneath, so their documentation
([Node](https://svelte.dev/docs/kit/adapter-node), [Bun](https://svelte.dev/docs/kit/adapter-bun))
is the reference for every environment variable.

## Behind a reverse proxy

Tell the server its public origin so SvelteKit generates correct absolute URLs and CSRF
checks on forms and remote functions pass. Set `paths.origin` in your config, and the
adapter bakes it into the build:

```ts
sveltekit({ adapter: adapter(), paths: { origin: 'https://chat.example.com' } });
```

To run one build behind more than one domain, leave `paths.origin` unset and derive the
origin from proxy headers instead: `PROTOCOL_HEADER=x-forwarded-proto`
`HOST_HEADER=x-forwarded-host`. Without either, the adapters take the host from the `Host`
header and assume `https`. For client IPs set `ADDRESS_HEADER=x-forwarded-for` (and
`XFF_DEPTH` to the number of trusted proxies).

## WebSockets behind nginx

The proxy has to forward WebSocket upgrades for the events endpoint (`/_events`). With
nginx that means HTTP/1.1 and the `Upgrade`/`Connection` headers:

```
location / {
	proxy_pass http://127.0.0.1:3000;
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection "upgrade";
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

nginx closes a proxied connection that stays silent for `proxy_read_timeout` (60 seconds by
default). The server pings every client every 15 seconds, so an idle socket never gets that
far and the default is fine.

## Docker

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/build build
COPY --from=deps /app/node_modules node_modules
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "./build"]
```

The `deps` stage installs production dependencies only, which keeps build tooling out of the
image: everything under `devDependencies` is already bundled into `build/`.

`bun run build` assumes the `build` script carries `--bun` (`bun --bun vite build`). With
`adapter-node` the script is plain `vite build` (`npm run build` works too); swap the runtime
image for `node:22-slim` and the command for `["node", "build"]`.

### Compose, with Redis

Scaling to more than one instance needs the [Redis pub/sub engine](/redis), so wire both
up in one file:

```yaml
# compose.yaml
services:
  app:
    build: .
    deploy:
      replicas: 2
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy

  redis:
    image: redis:8-alpine
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5
```

Put a load balancer in front of the replicas. Sticky sessions are not required: any
instance can serve any connection, and the bus fans messages out between them.

## systemd

```ini
[Unit]
Description=svelte-ws app
After=network.target

[Service]
ExecStart=/usr/local/bin/bun /srv/app/build
Environment=PORT=3000
Restart=on-failure
# the adapter handles SIGTERM: sveltekit:shutdown → drain → exit
TimeoutStopSec=35

[Install]
WantedBy=multi-user.target
```

## Scaling out

One instance needs nothing. Multiple instances need exactly one thing: a shared bus.
Swap in [Redis pub/sub](/redis) and a message published on one instance reaches
subscribers on all of them.

Sticky sessions are not on the list. The client keeps a single WebSocket, any instance can
serve it, and state attached at upgrade lives on that connection.

## Connection limits

`limits` in `socket.config.ts` bound what one connection can do (frame size, concurrent
operations, how far it may fall behind), not how many connections there are or how often a
client may call a mutation. Put those at the edge: `limit_conn` and `limit_req` in nginx,
or your load balancer's equivalent, and a [rate limit in the handler](/recipes#rate-limiting-a-connection) for
mutations that cost something.

## Graceful shutdown

SIGINT/SIGTERM: live WebSockets close with `1001`, the server stops accepting connections
and drains in-flight requests for up to `SHUTDOWN_TIMEOUT` (default 30 s), then
`sveltekit:shutdown` fires and `init`'s cleanup runs. See [the adapter](/adapter#graceful-shutdown).
