<script lang="ts">
	import ChatRoom from './ChatRoom.svelte';

	let room = $state('general');
	let rooms = ['general', 'random', 'dev'];
</script>

<div class="mx-auto flex max-w-xl flex-col gap-4 p-6">
	<h1 class="text-2xl font-bold">WebSocket demo</h1>
	<p class="text-sm text-gray-600">
		Real-time chat over a single multiplexed WebSocket (<code>.socket.ts</code> + channels). Open this
		page in two tabs to see live updates.
	</p>

	<div class="flex gap-2">
		{#each rooms as name (name)}
			<button
				class="rounded border px-3 py-1 {room === name ? 'bg-blue-600 text-white' : ''}"
				onclick={() => (room = name)}
			>
				#{name}
			</button>
		{/each}
	</div>

	{#key room}
		<ChatRoom {room} />
	{/key}
</div>
