/**
 * Pack the tarball and consume it the way npm would.
 *
 * `bun run package` proving the build works is not the same as the published artifact
 * working: `files`, the `exports` map and the emitted import specifiers only meet reality
 * once something installs the tarball by name. This installs it into a throwaway app and
 * imports every entry point.
 *
 * Run: `bun run smoke:pack`
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * Entries a plain Node process can import. `svelte-ws/client` is deliberately absent: it
 * is a runes module, compiled by the consumer's bundler rather than by us, and `svelte-ws/sv`
 * is the `sv add` add-on, which imports the CLI that runs it.
 */
const IMPORTABLE = [
	'svelte-ws',
	'svelte-ws/pubsub',
	'svelte-ws/config',
	'svelte-ws/testing',
	'svelte-ws/vite',
	'svelte-ws/adapter-bun',
	'svelte-ws/adapter-node'
];
const RESOLVE_ONLY = ['svelte-ws/client', 'svelte-ws/sv', 'svelte-ws/package.json'];

// under `npm publish` (as `prepublishOnly`) npm hands its own config down, `dry_run` included,
// which would turn the nested pack and install into no-ops; a consumer has none of it
const env = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name))
);

const run = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		env,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit']
	});

const dir = mkdtempSync(path.join(tmpdir(), 'svelte-ws-smoke-'));
try {
	console.log('packing…');
	const packed = run('npm', ['pack', '--pack-destination', dir, '--silent'], root)
		.trim()
		.split('\n')
		.at(-1);
	const tarball = path.join(dir, packed);

	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2)
	);

	console.log(`installing ${packed}…`);
	run('npm', ['install', tarball, '--no-audit', '--no-fund', '--silent'], dir);

	const check = IMPORTABLE.map(
		(entry) => `await import(${JSON.stringify(entry)}).then(
			(mod) => console.log('  ok  ${entry}', Object.keys(mod).length + ' exports'),
			(error) => { console.error('  FAIL ${entry}', error.message); failed = true; }
		);`
	).join('\n');

	const resolve = RESOLVE_ONLY.map(
		(
			entry
		) => `try { import.meta.resolve(${JSON.stringify(entry)}); console.log('  ok  ${entry} (resolved)'); }
		catch (error) { console.error('  FAIL ${entry}', error.message); failed = true; }`
	).join('\n');

	writeFileSync(
		path.join(dir, 'check.mjs'),
		`let failed = false;\n${check}\n${resolve}\nprocess.exit(failed ? 1 : 0);\n`
	);

	console.log(`importing every entry of ${pkg.name}@${pkg.version}:`);
	process.stdout.write(run('node', ['check.mjs'], dir));
	console.log('tarball is consumable ✓');
} finally {
	rmSync(dir, { recursive: true, force: true });
}
