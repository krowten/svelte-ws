import { defineConfig, devices } from '@playwright/test';

const BUN_PORT = 4179;
const NODE_PORT = 4180;
const origin = (port: number) => `http://127.0.0.1:${port}`;

/** `E2E_WEBKIT=1 bun run test:e2e` to add the Safari lanes locally (needs the system deps). */
const webkit = !!process.env.CI || !!process.env.E2E_WEBKIT;

/**
 * The same suite runs against both adapters' real output: a Bun server and a Node server.
 * The fixture in `app/` installs the package by name, so a run also covers the exports map.
 *
 * Servers are never reused — a stale one would silently test the wrong build.
 */
export default defineConfig({
	testDir: 'tests',
	testMatch: '**/*.e2e.{ts,js}',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	webServer: [
		{
			// adapter-bun calls Bun's build API, so the build itself has to run in Bun
			command: `E2E_ORIGIN=${origin(BUN_PORT)} bun --bun vite build && PORT=${BUN_PORT} HOST=127.0.0.1 bun ./build-bun/index.js`,
			cwd: 'app',
			port: BUN_PORT,
			reuseExistingServer: false,
			stdout: 'pipe'
		},
		{
			command: `ADAPTER=node E2E_ORIGIN=${origin(NODE_PORT)} vite build && PORT=${NODE_PORT} HOST=127.0.0.1 node ./build-node/index.js`,
			cwd: 'app',
			port: NODE_PORT,
			reuseExistingServer: false,
			stdout: 'pipe'
		}
	],
	projects: [
		{ name: 'bun', use: { ...devices['Desktop Chrome'], baseURL: origin(BUN_PORT) } },
		{ name: 'node', use: { ...devices['Desktop Chrome'], baseURL: origin(NODE_PORT) } },
		// WebSocket behaviour is the browser's, and Safari's differs from Chrome's often
		// enough to deserve its own lane — but WebKit needs system libraries a dev machine
		// may not have, so it runs in CI (which installs them) or on request.
		...(webkit
			? [
					{
						name: 'bun-webkit',
						use: { ...devices['Desktop Safari'], baseURL: origin(BUN_PORT) }
					},
					{
						name: 'node-webkit',
						use: { ...devices['Desktop Safari'], baseURL: origin(NODE_PORT) }
					}
				]
			: [])
	]
});
