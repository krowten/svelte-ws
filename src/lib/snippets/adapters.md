```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from 'svelte-ws/adapter-node'; // or 'svelte-ws/adapter-bun'

export default defineConfig({
	plugins: [sveltekit({ adapter: adapter() })]
});
```
