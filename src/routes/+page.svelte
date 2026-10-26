<script lang="ts">
	import { resolve } from '$app/paths';
	import Hero from '#lib/snippets/hero.md';
	import Adapters from '#lib/snippets/adapters.md';
	import Config from '#lib/snippets/config.md';
	import {
		AUTHOR,
		OG_IMAGE,
		REPO_URL,
		HOME_URL,
		SITE_NAME,
		SITE_TITLE,
		SITE_DESCRIPTION
	} from '#lib/site.js';
	import PageMeta from '#lib/components/PageMeta.svelte';
	import type { DocSlug } from '#lib/nav.js';
	import { version } from '../../package.json';

	const jsonLd = [
		{
			'@context': 'https://schema.org',
			'@type': 'SoftwareSourceCode',
			name: SITE_NAME,
			description: SITE_DESCRIPTION,
			url: HOME_URL,
			image: OG_IMAGE.url,
			codeRepository: REPO_URL,
			programmingLanguage: 'TypeScript',
			runtimePlatform: ['Bun', 'Node.js'],
			license: 'https://opensource.org/licenses/MIT',
			version,
			author: AUTHOR,
			keywords: 'sveltekit, websocket, realtime, remote functions, bun, node, redis, pub/sub'
		},
		{
			'@context': 'https://schema.org',
			'@type': 'WebSite',
			name: SITE_NAME,
			url: HOME_URL
		}
	];

	const features = [
		{
			title: 'Remote functions, over WebSockets',
			body: 'Write *.socket.ts like *.remote.ts: stream() is a live query, mutate() is a command. One multiplexed connection per app.',
			slug: 'streams'
		},
		{
			title: 'One bus for every transport',
			body: 'publish/subscribe works the same from a socket handler, a remote command, or +server.ts. In-memory by default; swap in Redis to fan out across instances.',
			slug: 'pubsub'
		},
		{
			title: 'Bun and Node adapters',
			body: 'SvelteKit’s official adapter-node and adapter-bun, with a WebSocket endpoint added. Static files, environment variables and shutdown stay theirs.',
			slug: 'adapter'
		},
		{
			title: 'One config for dev and prod',
			body: 'socket.config.ts runs at startup in vite dev and on the built server: init code, upgrade auth, limits, WebSocket tuning.',
			slug: 'server-config'
		},
		{
			title: 'Reconnects, and resumes',
			body: 'The client reconnects with backoff and re-subscribes every stream. Give a stream a cursor and it picks up after the last value the client saw.',
			slug: 'streams'
		},
		{
			title: 'Tests without a server',
			body: 'createTestClient runs your socket modules over an in-memory socket in Vitest, with the real connection, schemas and upgrade hook.',
			slug: 'testing'
		}
	] satisfies { title: string; body: string; slug: DocSlug }[];
</script>

<PageMeta
	title={SITE_TITLE}
	socialTitle="WebSocket remote functions for SvelteKit"
	description={SITE_DESCRIPTION}
	url={HOME_URL}
	type="website"
	{jsonLd}
/>

<section class="mx-auto max-w-[1152px] px-6 pt-20 pb-16 text-center">
	<h1
		class="mx-auto max-w-3xl text-5xl font-bold tracking-tight text-vp-fg-strong dark:text-vpd-fg"
	>
		WebSocket <span class="text-brand">remote functions</span> for SvelteKit
	</h1>
	<p class="mx-auto mt-5 max-w-2xl text-lg text-vp-fg-muted dark:text-vpd-fg-muted">
		Author realtime streams and mutations the way you write remote functions: validated, type-safe,
		multiplexed over a single socket, served by Bun or Node.
	</p>

	<div class="mt-8 flex justify-center gap-3">
		<a
			href={resolve('/(docs)/getting-started')}
			class="rounded-full bg-brand px-6 py-2.5 font-medium text-white hover:bg-brand-soft"
		>
			Get started
		</a>
		<a
			href="https://github.com/krowten/svelte-ws"
			target="_blank"
			rel="noreferrer"
			class="rounded-full border border-vp-divider px-6 py-2.5 font-medium text-vp-fg-strong hover:border-brand dark:border-vpd-divider dark:text-vpd-fg"
		>
			GitHub
		</a>
	</div>

	<p class="mt-6 text-sm text-vp-fg-muted dark:text-vpd-fg-muted">
		<code
			class="rounded bg-vp-bg-mute px-2 py-1 font-mono text-vp-fg-strong dark:bg-vpd-bg-mute dark:text-vpd-fg"
			>bun add svelte-ws</code
		>
		<span class="ml-2">SvelteKit 3 · Svelte 5 · Bun 1.4+ or Node 22.17+</span>
	</p>

	<div class="docs-prose mx-auto mt-14 max-w-2xl text-left">
		<Hero />
	</div>
</section>

<section class="border-t border-vp-divider dark:border-vpd-divider">
	<div class="mx-auto grid max-w-[1152px] gap-8 px-6 py-14 lg:grid-cols-2">
		<!-- min-w-0: a grid item otherwise refuses to shrink below its longest code line -->
		<div class="min-w-0">
			<h2 class="font-semibold text-vp-fg-strong dark:text-vpd-fg">Wire it up once</h2>
			<p class="mt-2 text-sm leading-6 text-vp-fg-muted dark:text-vpd-fg-muted">
				A plugin and an adapter, with nothing added to <code>hooks.server.ts</code> and no second server:
				the dev server serves the endpoint itself.
			</p>
			<div class="docs-prose mt-4"><Adapters /></div>
		</div>
		<div class="min-w-0">
			<h2 class="font-semibold text-vp-fg-strong dark:text-vpd-fg">Own the server</h2>
			<p class="mt-2 text-sm leading-6 text-vp-fg-muted dark:text-vpd-fg-muted">
				Optional <code>socket.config.ts</code>: startup code, authentication at the upgrade,
				per-connection limits and error handling, identical in dev and production.
			</p>
			<div class="docs-prose mt-4"><Config /></div>
		</div>
	</div>
</section>

<section class="border-t border-vp-divider dark:border-vpd-divider">
	<div class="mx-auto max-w-[1152px] px-6 py-14">
		<h2 class="text-2xl font-semibold tracking-tight text-vp-fg-strong dark:text-vpd-fg">
			Why svelte-ws
		</h2>
		<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each features as feature (feature.title)}
				<a
					href={resolve(`/(docs)/${feature.slug}`)}
					class="rounded-xl border border-transparent bg-vp-bg-soft p-6 hover:border-brand dark:bg-vpd-bg-soft"
				>
					<h3 class="font-semibold text-vp-fg-strong dark:text-vpd-fg">{feature.title}</h3>
					<p class="mt-2 text-sm leading-6 text-vp-fg-muted dark:text-vpd-fg-muted">
						{feature.body}
					</p>
				</a>
			{/each}
		</div>
	</div>
</section>
