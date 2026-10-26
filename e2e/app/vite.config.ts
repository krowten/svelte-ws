import process from 'node:process';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import bunAdapter from 'svelte-ws/adapter-bun';
import nodeAdapter from 'svelte-ws/adapter-node';

// The fixture consumes the package the way an installed app does — by name, through the
// exports map — so the e2e run also proves `dist` and `exports` are wired correctly. The
// adapters add the `sveltekitSocket()` plugin themselves.
const target = process.env.ADAPTER === 'node' ? 'node' : 'bun';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},
			adapter:
				target === 'node'
					? nodeAdapter({ out: 'build-node' })
					: bunAdapter({ out: 'build-bun', precompress: true }),
			// the public origin for CSRF checks on remote calls; set per server by playwright
			paths: { origin: process.env.E2E_ORIGIN },
			experimental: { remoteFunctions: true }
		})
	]
});
