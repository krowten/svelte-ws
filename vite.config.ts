import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { mdsvex, escapeSvelte } from 'mdsvex';
import rehypeSlug from 'rehype-slug';
import { createHighlighter } from 'shiki';

// fuzz.svelte.spec.ts: pass the seed from a failure to replay it, more runs to dig deeper
const { FUZZ_SEED = '20261019', FUZZ_RUNS = '20', FUZZ_STEPS = '40' } = process.env;
const fuzz = { seed: Number(FUZZ_SEED), runs: Number(FUZZ_RUNS), steps: Number(FUZZ_STEPS) };

// one highlighter for the whole build; dual themes switch via CSS variables
const highlighter = await createHighlighter({
	themes: ['github-light', 'github-dark'],
	langs: [
		'typescript',
		'javascript',
		'svelte',
		'bash',
		'json',
		'html',
		'css',
		'dockerfile',
		'ini',
		'nginx',
		'yaml'
	]
});

// '/svelte-ws' on GitHub Pages (project page), '' locally
const BASE_PATH = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

type MdNode = { type?: string; url?: string; children?: MdNode[] };

/** Prefix root-absolute link/image urls in markdown with the deploy base path. */
function remarkBasePath() {
	return (tree: MdNode) => {
		if (!BASE_PATH) return;
		const walk = (node: MdNode) => {
			if ((node.type === 'link' || node.type === 'image') && node.url?.startsWith('/')) {
				node.url = BASE_PATH + node.url;
			}
			node.children?.forEach(walk);
		};
		walk(tree);
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			extensions: ['.svelte', '.md'],
			paths: { base: BASE_PATH },
			preprocess: [
				mdsvex({
					extensions: ['.md'],
					remarkPlugins: [remarkBasePath],
					rehypePlugins: [rehypeSlug],
					highlight: {
						highlighter: (code, lang) => {
							const html = highlighter.codeToHtml(code, {
								lang: lang ?? 'text',
								themes: { light: 'github-light', dark: 'github-dark' },
								defaultColor: false
							});
							return `{@html \`${escapeSvelte(html)}\`}`;
						}
					}
				})
			],
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// the docs site is fully static (GitHub Pages); e2e/ exercises the svelte-ws adapters
			// GitHub Pages serves 404.html for any unknown path; as a SPA fallback it boots the
			// client router, which renders +error.svelte with the docs index
			adapter: adapter({ fallback: '404.html' }),
			// these files are linked from robots.txt or nowhere, so the crawler never finds them
			prerender: { entries: ['*', '/sitemap.xml', '/llms.txt', '/llms-full.txt'] }
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**'],
					provide: { fuzz }
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					provide: { fuzz }
				}
			}
		]
	}
});
