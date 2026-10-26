import { expect, test } from '@playwright/test';

test('uses a single events WebSocket connection', async ({ page }) => {
	let connections = 0;
	page.on('websocket', (ws) => {
		if (ws.url().includes('/_events')) connections++;
	});

	await page.goto('/');
	await expect(page.getByText('connected', { exact: true })).toBeVisible();
	await page.waitForTimeout(300);

	expect(connections).toBe(1);
});

test('delivers messages across tabs and isolates channels', async ({ browser }) => {
	const a = await (await browser.newContext()).newPage();
	const b = await (await browser.newContext()).newPage();

	await a.goto('/');
	await b.goto('/');
	await expect(a.getByText('connected', { exact: true })).toBeVisible();
	await expect(b.getByText('connected', { exact: true })).toBeVisible();

	// a message posted in #general reaches both tabs
	const message = `hello-${Date.now()}`;
	await a.getByPlaceholder('Message #general').fill(message);
	await a.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(b.getByText(message)).toBeVisible();
	await expect(a.getByText(message)).toBeVisible();

	// switch tab A to #random; a message there must NOT reach tab B (still in #general)
	await a.getByRole('button', { name: '#random' }).click();
	await expect(a.getByText('connected', { exact: true })).toBeVisible();
	const otherRoom = `random-${Date.now()}`;
	await a.getByPlaceholder('Message #random').fill(otherRoom);
	await a.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(a.getByText(otherRoom)).toBeVisible();
	await expect(b.getByText(otherRoom)).toHaveCount(0);
});

test('a message sent via HTTP command arrives over the WebSocket stream (shared bus)', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByText('connected', { exact: true })).toBeVisible();

	const message = `via-http-${Date.now()}`;
	await page.getByPlaceholder('Message #general').fill(message);
	// publishes over HTTP (remote command) → same bus → ws stream renders it
	await page.getByRole('button', { name: 'Send via HTTP' }).click();
	await expect(page.getByText(message)).toBeVisible();
});

test('upgrade hook sets a cookie on the 101 and exposes ctx.data to handlers', async ({
	page,
	context
}) => {
	await page.goto('/');
	await expect(page.getByText('connected', { exact: true })).toBeVisible();

	// `whoami` returns ctx.data.visitor, which the upgrade hook read from / set into the cookie
	const visitor = page.getByTestId('visitor');
	await expect(visitor).not.toBeEmpty();
	const shown = await visitor.textContent();

	const cookie = (await context.cookies()).find((c) => c.name === 'visitor');
	expect(cookie?.value).toBe(shown);
});

test('replays what a drop swallowed, so no message is lost', async ({ browser }) => {
	// two contexts: one to break, one to keep posting while the first is away
	const reader = await (await browser.newContext()).newPage();
	const writer = await (await browser.newContext()).newPage();

	await reader.addInitScript(() => {
		const sockets: WebSocket[] = [];
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...args: ConstructorParameters<typeof Native>) {
				super(...args);
				sockets.push(this);
			}
		};
		(window as { __sockets?: WebSocket[] }).__sockets = sockets;
	});

	await reader.goto('/');
	await writer.goto('/');
	await expect(reader.getByText('connected', { exact: true })).toBeVisible();
	await expect(writer.getByText('connected', { exact: true })).toBeVisible();

	// anchor the cursor: the reader must receive at least one message first
	const anchor = `anchor-${Date.now()}`;
	await writer.getByPlaceholder('Message #general').fill(anchor);
	await writer.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(reader.getByText(anchor)).toBeVisible();

	// cut the reader off, post while it is away, then let it come back
	await reader.evaluate(() => {
		for (const ws of (window as { __sockets?: WebSocket[] }).__sockets ?? []) ws.close();
	});
	const missed = `missed-${Date.now()}`;
	await writer.getByPlaceholder('Message #general').fill(missed);
	await writer.getByRole('button', { name: 'Send', exact: true }).click();

	// the resumed stream replays from the cursor — the message sent during the outage lands
	await expect(reader.getByText(missed)).toBeVisible();
});

test('leaving a quiet room ends its server subscription', async ({ page, request }) => {
	const live = async () => (await request.get('/live?room=dev')).json();

	await page.goto('/');
	await page.getByRole('button', { name: '#dev' }).click();
	await expect(page.getByText('connected', { exact: true })).toBeVisible();
	await expect.poll(live).toBe(1);

	// nobody posts in #dev, so only the stream's own cancellation can end the subscription
	await page.getByRole('button', { name: '#general' }).click();
	await expect.poll(live).toBe(0);
});

test('a stream survives a dropped connection (reconnect + resubscribe)', async ({ page }) => {
	// track every WebSocket the app opens so the test can kill them for real
	await page.addInitScript(() => {
		const sockets: WebSocket[] = [];
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(...args: ConstructorParameters<typeof NativeWebSocket>) {
				super(...args);
				sockets.push(this);
			}
		};
		(window as { __sockets?: WebSocket[] }).__sockets = sockets;
	});

	await page.goto('/');
	await expect(page.getByText('connected', { exact: true })).toBeVisible();

	// drop the connection; the runtime must notice and reconnect with backoff
	await page.evaluate(() => {
		for (const ws of (window as { __sockets?: WebSocket[] }).__sockets ?? []) ws.close();
	});
	await expect(page.getByText('connected', { exact: true })).toBeVisible();

	const message = `after-reconnect-${Date.now()}`;
	await page.getByPlaceholder('Message #general').fill(message);
	await page.getByRole('button', { name: 'Send', exact: true }).click();
	await expect(page.getByText(message)).toBeVisible();
});

// ---- HTTP surface of the adapters (runs against both the Bun and the Node server) ----

// Static files are the official adapters' job (adapter-node, and the adapter-bun fork's
// untouched upstream code); these only check that wrapping them kept that side working.
test('serves client assets with a validator and answers 304', async ({ request }) => {
	// discover a hashed asset from the page itself
	const html = await (await request.get('/')).text();
	const asset = /\/_app\/immutable\/[^"']+\.js/.exec(html)?.[0];
	expect(asset, 'the page should reference an immutable asset').toBeTruthy();

	const first = await request.get(asset!);
	expect(first.status()).toBe(200);
	expect(first.headers()['content-type']).toContain('text/javascript');
	expect(first.headers()['cache-control']).toContain('immutable');

	const etag = first.headers()['etag'];
	expect(etag).toBeTruthy();
	const second = await request.get(asset!, { headers: { 'if-none-match': etag } });
	expect(second.status()).toBe(304);
});

test('negotiates a precompressed variant when the client accepts one', async ({ request }) => {
	const html = await (await request.get('/')).text();
	const asset = /\/_app\/immutable\/[^"']+\.js/.exec(html)?.[0];

	const brotli = await request.get(asset!, { headers: { 'accept-encoding': 'br' } });
	expect(brotli.status()).toBe(200);
	expect(brotli.headers()['vary']?.toLowerCase()).toContain('accept-encoding');
	// playwright decodes the body for us; the header proves the variant was picked
	expect(brotli.headers()['content-encoding']).toBe('br');

	const plain = await request.get(asset!, { headers: { 'accept-encoding': 'identity' } });
	expect(plain.headers()['content-encoding']).toBeUndefined();
});

test('serves static files and 404s unknown paths through SvelteKit', async ({ request }) => {
	const robots = await request.get('/robots.txt');
	expect(robots.status()).toBe(200);
	expect(robots.headers()['content-type']).toContain('text/plain');

	expect((await request.get('/definitely-not-a-route')).status()).toBe(404);
});

test('finds static files whose names need percent-decoding', async ({ request }) => {
	const withSpace = await request.get('/hello%20world.txt');
	expect(withSpace.status()).toBe(200);
	expect((await withSpace.text()).trim()).toBe('hello world');

	const unicode = await request.get(`/${encodeURIComponent('тест.txt')}`);
	expect(unicode.status()).toBe(200);
	expect((await unicode.text()).trim()).toBe('тест');
});
