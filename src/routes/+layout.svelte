<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import { GOOGLE_SITE_VERIFICATION } from '$app/env/public';
	import { asset, resolve } from '$app/paths';
	import { version } from '../../package.json';
	import Search from '#lib/components/Search.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';

	let { children } = $props();

	// every route except the landing page is documentation
	// (route id, not pathname: the id doesn't change with the deploy base or while prerendering)
	const inDocs = $derived(page.route.id !== '/');
</script>

<svelte:head>
	<!-- description, canonical and og:* belong to the page: the landing sets its own, docs
	     pages take theirs from `nav.ts`. A copy here would ship two of each tag. -->
	<!-- a real file, not an inlined data: URI, so search engines can fetch it for results -->
	<link rel="icon" href={asset('favicon.svg')} type="image/svg+xml" />
	<link rel="apple-touch-icon" href={asset('apple-touch-icon.png')} />
	{#if GOOGLE_SITE_VERIFICATION}
		<meta name="google-site-verification" content={GOOGLE_SITE_VERIFICATION} />
	{/if}
</svelte:head>

<div class="min-h-screen bg-vp-bg text-vp-fg dark:bg-vpd-bg dark:text-vpd-fg">
	<header
		class="fixed inset-x-0 top-0 z-40 border-b border-vp-divider bg-vp-bg/90 backdrop-blur dark:border-vpd-divider dark:bg-vpd-bg/90"
	>
		<nav class="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
			<a href={resolve('/')} class="flex items-center gap-2.5 font-semibold">
				<!-- signature: a live connection dot — this is a WebSocket library -->
				<span class="relative flex h-2.5 w-2.5">
					<span
						class="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none"
					></span>
					<span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand"></span>
				</span>
				<span class="whitespace-nowrap text-vp-fg-strong dark:text-vpd-fg">svelte-ws</span>
			</a>

			<div class="ml-auto flex items-center gap-2 text-sm font-medium">
				<Search />
				<a
					href={resolve('/(docs)/introduction')}
					class="rounded-md px-3 py-2 {inDocs
						? 'text-brand'
						: 'text-vp-fg hover:text-brand dark:text-vpd-fg dark:hover:text-brand'}"
				>
					Docs
				</a>
				<a
					href="https://github.com/krowten/svelte-ws"
					target="_blank"
					rel="noreferrer"
					class="rounded-md px-3 py-2 text-vp-fg hover:text-brand dark:text-vpd-fg dark:hover:text-brand"
				>
					GitHub
				</a>
				<ThemeToggle />
			</div>
		</nav>
	</header>

	<main class="pt-16">
		{@render children()}
	</main>

	<footer
		class="border-t border-vp-divider px-6 py-8 text-center text-sm text-vp-fg-muted dark:border-vpd-divider dark:text-vpd-fg-muted"
	>
		svelte-ws {version} ·
		<a class="hover:text-brand" href="https://github.com/krowten/svelte-ws/blob/main/LICENSE"
			>MIT License</a
		>
		·
		<a class="hover:text-brand" href="https://github.com/krowten/svelte-ws/blob/main/CHANGELOG.md"
			>Changelog</a
		>
		·
		<a class="hover:text-brand" href="https://github.com/krowten/svelte-ws">GitHub</a> ·
		<a class="hover:text-brand" href="https://github.com/krowten/svelte-ws/issues">Issues</a>
	</footer>
</div>
