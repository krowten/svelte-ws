import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { add } from 'sv';
import addon from './sv.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A bare SvelteKit 3 project: just what the add-on reads and edits. */
function project(adapterImport: string, adapterCall: string) {
	const cwd = mkdtempSync(path.join(tmpdir(), 'svelte-ws-sv-'));
	dirs.push(cwd);
	writeFileSync(
		path.join(cwd, 'package.json'),
		JSON.stringify({
			name: 'app',
			type: 'module',
			scripts: { dev: 'vite dev', build: 'vite build' },
			devDependencies: { '@sveltejs/kit': '^3.0.0', [adapterImport]: '^1.0.0', vite: '^8.0.0' }
		})
	);
	writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
	writeFileSync(
		path.join(cwd, 'vite.config.ts'),
		[
			`import adapter from '${adapterImport}';`,
			`import { sveltekit } from '@sveltejs/kit/vite';`,
			`import { defineConfig } from 'vite';`,
			``,
			`export default defineConfig({ plugins: [sveltekit({ adapter: ${adapterCall} })] });`
		].join('\n')
	);
	const read = (file: string) => readFileSync(path.join(cwd, file), 'utf8');
	return { cwd, read, exists: (file: string) => existsSync(path.join(cwd, file)) };
}

async function run(cwd: string, options: { adapter: 'node' | 'bun'; demo: boolean }) {
	await add({ cwd, addons: { 'svelte-ws': addon }, options: { 'svelte-ws': options } });
}

describe('sv add svelte-ws', () => {
	it('swaps adapter-node for svelte-ws/adapter-node and keeps its options', async () => {
		const app = project('@sveltejs/adapter-node', `adapter({ out: 'dist' })`);
		await run(app.cwd, { adapter: 'node', demo: true });

		expect(app.read('vite.config.ts')).toContain(`from 'svelte-ws/adapter-node'`);
		expect(app.read('vite.config.ts')).toContain(`out: 'dist'`);
		const pkg = JSON.parse(app.read('package.json'));
		expect(pkg.dependencies['svelte-ws']).toMatch(/^\^\d/);
		expect(pkg.devDependencies['@sveltejs/adapter-node']).toBeUndefined();
		expect(pkg.scripts.build).toBe('vite build');
		expect(pkg.dependencies.valibot).toMatch(/^\^1/);
		expect(app.read('src/routes/socket/board.socket.ts')).toContain('publish(');
		expect(app.read('src/routes/socket/+page.svelte')).toContain('<script lang="ts">');
	});

	it('moves another adapter to svelte-ws/adapter-bun with a Bun build and no demo', async () => {
		const app = project('@sveltejs/adapter-auto', `adapter({ some: 'option' })`);
		await run(app.cwd, { adapter: 'bun', demo: false });

		expect(app.read('vite.config.ts')).toContain(`from 'svelte-ws/adapter-bun'`);
		expect(app.read('vite.config.ts')).not.toContain('some');
		const pkg = JSON.parse(app.read('package.json'));
		expect(pkg.devDependencies['@sveltejs/adapter-auto']).toBeUndefined();
		expect(pkg.scripts.build).toBe('bun --bun vite build');
		expect(pkg.dependencies?.valibot).toBeUndefined();
		expect(app.exists('src/routes/socket')).toBe(false);

		await run(app.cwd, { adapter: 'bun', demo: false });
		expect(JSON.parse(app.read('package.json')).scripts.build).toBe('bun --bun vite build');
	});
});
