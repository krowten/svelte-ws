<script lang="ts">
	import { untrack } from 'svelte';
	import { messages, send, whoami } from './chat.socket';
	import { sendViaCommand } from './chat.remote';
	import type { ChatMessage } from './chat-shared';

	let { room }: { room: string } = $props();

	// one shared stream for this room; the parent keys on `room`, so this component remounts
	// when the room changes — capture the value once and auto-release on destroy.
	const feed = messages({ room: untrack(() => room) });

	let history = $state<ChatMessage[]>([]);
	let draft = $state('');
	// the visitor id the `upgrade` hook attached to this connection (ctx.data)
	let visitor = $state<string | null>(null);

	$effect(() => {
		if (feed.connected && visitor === null) {
			whoami().then((id) => (visitor = id));
		}
	});

	// accumulate every value the live stream yields
	$effect(() => {
		const message = feed.current;
		if (message) untrack(() => history.push(message));
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		draft = '';
		await send({ room, text }); // over the WebSocket
	}

	async function submitViaCommand() {
		const text = draft.trim();
		if (!text) return;
		draft = '';
		await sendViaCommand({ room, text }); // over HTTP, same bus → shows up in the stream
	}
</script>

<div class="flex flex-col gap-3">
	<p class="text-sm">
		Status:
		<span class={feed.connected ? 'text-green-600' : 'text-red-600'}>
			{feed.connected ? 'connected' : 'disconnected'}
		</span>
		· room <strong>{room}</strong>
		{#if visitor}
			· you are <strong data-testid="visitor">{visitor}</strong>
		{/if}
	</p>

	<ul class="flex h-64 flex-col gap-1 overflow-y-auto rounded border p-2 text-sm">
		{#each history as message (message.id)}
			<li>
				<span class="text-gray-400">{new Date(message.at).toLocaleTimeString()}</span>
				{message.text}
			</li>
		{:else}
			<li class="text-gray-400">No messages yet — say something!</li>
		{/each}
	</ul>

	<form class="flex gap-2" onsubmit={submit}>
		<input
			class="flex-1 rounded border px-2 py-1"
			bind:value={draft}
			placeholder="Message #{room}"
			autocomplete="off"
		/>
		<button class="rounded bg-blue-600 px-3 py-1 text-white" type="submit">Send</button>
		<button class="rounded border px-3 py-1" type="button" onclick={submitViaCommand}>
			Send via HTTP
		</button>
	</form>
</div>
