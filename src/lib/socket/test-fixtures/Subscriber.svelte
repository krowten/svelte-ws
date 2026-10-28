<!--
	Test-only: subscribes to a stream the way an app component does, so the client runtime
	ties the subscription to this component's lifetime. Hands the handle back to the test.
-->
<script lang="ts">
	import type { Stream, StreamFn } from '../types.js';

	import { untrack } from 'svelte';

	type Props = {
		stream: StreamFn<unknown, unknown>;
		args: unknown;
		onhandle: (handle: Stream<unknown>) => void;
	};

	const props: Props = $props();

	untrack(() => props.onhandle(props.stream(props.args)));
</script>
