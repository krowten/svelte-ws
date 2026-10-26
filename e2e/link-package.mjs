/**
 * The fixture imports the library **by name** (`svelte-ws/vite`, `svelte-ws/adapter-node`),
 * so the e2e run also proves the published `exports` map is wired correctly.
 *
 * A `file:../..` dependency would be wrong for that: bun copies it as a snapshot taken at
 * install time, so `bun run package` would update `dist/` while the fixture kept testing an
 * older build — silently green tests for code that no longer exists. Symlink instead, so the
 * fixture always sees the current `dist/`.
 */
import { lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(here, 'app', 'node_modules');
const link = path.join(modules, 'svelte-ws');

const current = (() => {
	try {
		return lstatSync(link);
	} catch {
		return null;
	}
})();

if (current?.isSymbolicLink()) process.exit(0); // already linked

mkdirSync(modules, { recursive: true });
if (current) rmSync(link, { recursive: true, force: true });
symlinkSync(path.relative(modules, path.join(here, '..')), link, 'junction');
console.log('linked svelte-ws into the e2e fixture');
