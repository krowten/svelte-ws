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

const DEMO_SOCKET = `import { stream } from 'svelte-ws';

export const clock = stream(async function* (_args, ctx) {
	while (!ctx.signal.aborted) {
		yield new Date().toISOString();
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
});
`;

const DEMO_PAGE = `<script>
	import { clock } from './ticker.socket';

	const time = clock();
</script>

<time>{time.current ?? '…'}</time>
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
		question: 'Add a demo page with a live clock?',
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

	run: ({ sv, options, cwd, file, language, directory }) => {
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
			const dir = `${directory.kitRoutes}/ticker`;
			sv.file(`${dir}/ticker.socket.${language}`, (content) => (content ? false : DEMO_SOCKET));
			sv.file(`${dir}/+page.svelte`, (content) => (content ? false : DEMO_PAGE));
		}
	},

	nextSteps: ({ options }) => [
		...(options.demo ? [`Open ${color.route('/ticker')} in the dev server`] : []),
		`Docs: ${color.website('https://krowten.github.io/svelte-ws/getting-started')}`
	]
});
