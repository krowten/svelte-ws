/**
 * The `sv add svelte-ws` community add-on: installs the package, swaps the project's adapter
 * for a svelte-ws one and, optionally, adds a demo socket module.
 *
 * The CLI loads this entry from its own install, where only `sv` and `@sveltejs/sv-utils`
 * resolve: import nothing else here, including the rest of this package.
 */
import { createRequire } from 'node:module';

import { color, svelteConfig, transforms } from '@sveltejs/sv-utils';
import { defineAddon, defineAddonOptions } from 'sv';

// shortcut: sv-utils comes unbundled from the running `sv`, so a breaking sv-utils release
// can break the add-on; bundle it (tsdown) if that ever happens
const { version } = createRequire(import.meta.url)('svelte-ws/package.json') as {
	version: string;
};

const ADAPTER_IMPORT = /^(@sveltejs|svelte-ws)\/adapter-/;

const DEMO_SOCKET = (ts: boolean) => `import * as v from 'valibot';
import { mutate, stream } from 'svelte-ws';
import { publish, subscribe } from 'svelte-ws/pubsub';
${ts ? '\ntype Message = { id: string; text: string; at: number };\n' : ''}
// kept in this server's memory: gone after a restart, and not shared between instances
${ts ? 'let messages: Message[] = [];' : '/** @type {{ id: string; text: string; at: number }[]} */\nlet messages = [];'}

/** The latest messages, sent again in full to every open tab whenever one is posted. */
export const board = stream(async function* () {
	// subscribe before the first yield, so nothing posted in between is missed
	${ts ? "const updates = subscribe<Message[]>('board');" : "/** @type {AsyncIterable<typeof messages>} */\n\tconst updates = subscribe('board');"}
	yield messages;
	yield* updates;
});

/** Adds a message and publishes the new list to every \`board\` stream. */
export const post = mutate(
	v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
	(text) => {
		messages = [...messages, { id: crypto.randomUUID(), text, at: Date.now() }].slice(-20);
		publish('board', messages);
	}
);
`;

const DEMO_PAGE = (ts: boolean) => `<script${ts ? ' lang="ts"' : ''}>
	import { board, post } from './board.socket';

	// every tab streams the same list; post() publishes a new one to all of them
	const feed = board();

	let text = $state('');
	let failed = $state(false);

	async function send() {
		failed = false;
		try {
			await post(text);
			text = '';
		} catch {
			failed = true;
		}
	}
</script>

<svelte:head>
	<title>svelte-ws demo</title>
</svelte:head>

<main>
	<header>
		<h1>Message board</h1>
		<span class="status" class:online={feed.connected}>
			{feed.connected ? 'connected' : 'connecting…'}
		</span>
	</header>
	<p class="hint">Open this page in a second tab: a message posted in one shows up in both.</p>

	{#if feed.current}
		<ol>
			{#each feed.current as message (message.id)}
				<li>
					<time>{new Date(message.at).toLocaleTimeString()}</time>
					{message.text}
				</li>
			{:else}
				<li class="empty">No messages yet.</li>
			{/each}
		</ol>
	{/if}

	<form
		onsubmit={(event) => {
			event.preventDefault();
			send();
		}}
	>
		<input
			bind:value={text}
			aria-label="Message"
			placeholder="Say something"
			maxlength="200"
			autocomplete="off"
		/>
		<button disabled={!text.trim()}>Send</button>
	</form>
	{#if failed}
		<p class="error" role="alert">Not sent, try again.</p>
	{/if}
</main>

<style>
	main {
		--accent: #ff3e00;
		--muted: #6b7280;
		--line: #e5e7eb;
		max-width: 32rem;
		margin: 4rem auto;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		font-family: system-ui, sans-serif;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h1 {
		margin: 0;
		font-size: 1.25rem;
	}

	.status {
		font-size: 0.875rem;
		color: var(--muted);
	}

	.status::before {
		content: '';
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		margin-right: 0.4rem;
		border-radius: 50%;
		background: var(--muted);
	}

	.status.online::before {
		background: #22c55e;
	}

	.hint,
	.empty,
	time {
		color: var(--muted);
	}

	.hint {
		font-size: 0.875rem;
	}

	ol {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 1.5rem 0;
		padding: 0;
		list-style: none;
	}

	time {
		margin-right: 0.5rem;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	form {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		font: inherit;
		background: transparent;
	}

	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	button {
		padding: 0.5rem 1rem;
		border: 0;
		border-radius: 0.5rem;
		font: inherit;
		color: white;
		background: var(--accent);
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.error {
		color: #dc2626;
		font-size: 0.875rem;
	}
</style>
`;

const options = defineAddonOptions()
	.add('adapter', {
		question: 'Which runtime will serve the app in production?',
		type: 'select',
		default: 'node',
		options: [
			{ value: 'node', hint: 'svelte-ws/adapter-node' },
			{ value: 'bun', hint: 'svelte-ws/adapter-bun' }
		]
	})
	.add('demo', {
		question: 'Add a demo page with a message board shared between tabs?',
		type: 'boolean',
		default: true
	})
	.build();

export default defineAddon({
	id: 'svelte-ws',
	shortDescription: 'WebSocket remote functions',
	homepage: 'https://krowten.github.io/svelte-ws/',
	options,

	setup: ({ isKit, unsupported, dependencyVersion }) => {
		if (!isKit) return unsupported('Requires SvelteKit');
		const kit = Number.parseInt(dependencyVersion('@sveltejs/kit') ?? '');
		if (kit < 3) unsupported('Requires SvelteKit 3');
	},

	run: ({ sv, options, cwd, file, language, directory, dependencyVersion }) => {
		const adapter = `svelte-ws/adapter-${options.adapter}`;
		let previous: string | undefined;

		sv.dependency('svelte-ws', `^${version}`);

		svelteConfig.edit({ sv, cwd }, ({ ast, js, override }) => {
			const existing = ast.body.find(
				(node) =>
					node.type === 'ImportDeclaration' &&
					typeof node.source.value === 'string' &&
					ADAPTER_IMPORT.test(node.source.value) &&
					node.specifiers?.some((s) => s.type === 'ImportDefaultSpecifier')
			);
			if (existing?.type !== 'ImportDeclaration') {
				js.imports.addDefault(ast, { from: adapter, as: 'adapter' });
				override({
					adapter: js.functions.createCall({ name: 'adapter', args: [], useIdentifiers: true })
				});
				return;
			}

			const source = existing.source.value as string;
			const name = existing.specifiers!.find((s) => s.type === 'ImportDefaultSpecifier')!.local
				.name as string;
			if (source.startsWith('@sveltejs/')) previous = source;
			existing.source.value = adapter;
			existing.source.raw = undefined;
			// both svelte-ws adapters take their upstream adapter's options, so keep the call as is
			// when only the import changes; a different family starts from defaults
			if (source.replace(ADAPTER_IMPORT, '') !== options.adapter) {
				override(
					{ adapter: js.functions.createCall({ name, args: [], useIdentifiers: true }) },
					{ dropLeadingComments: ['adapter'] }
				);
			}
		});

		sv.file(
			file.package,
			transforms.json(({ data }) => {
				if (previous) {
					delete data.dependencies?.[previous];
					delete data.devDependencies?.[previous];
				}
				// adapter-bun calls Bun's build API, so the build has to run inside Bun
				const build: string = data.scripts?.build ?? 'vite build';
				if (options.adapter === 'bun' && !build.includes('bun --bun')) {
					(data.scripts ??= {}).build = build.replace('vite build', 'bun --bun vite build');
				}
			})
		);

		if (options.demo) {
			const ts = language === 'ts';
			const dir = `${directory.kitRoutes}/socket`;
			// the demo validates its input with valibot, as SvelteKit's remote function docs do
			if (!dependencyVersion('valibot')) sv.dependency('valibot', '^1.0.0');
			sv.file(`${dir}/board.socket.${language}`, (content) => (content ? false : DEMO_SOCKET(ts)));
			sv.file(`${dir}/+page.svelte`, (content) => (content ? false : DEMO_PAGE(ts)));
		}
	},

	nextSteps: ({ options }) => [
		...(options.demo ? [`Open ${color.route('/socket')} in two tabs of the dev server`] : []),
		`Docs: ${color.website('https://krowten.github.io/svelte-ws/getting-started')}`
	]
});
