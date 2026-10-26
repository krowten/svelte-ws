declare module 'virtual:svelte-ws/manifest' {
	/** module id -> loader for that module's `?socket-server` build. */
	export const modules: Record<string, () => Promise<Record<string, unknown>>>;
}
