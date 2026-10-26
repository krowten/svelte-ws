/**
 * `build/index.js` for svelte-ws's Node adapter: adapter-node's own entry, preceded by the
 * WebSocket module. Import order is evaluation order, so `socket.config` is initialised
 * before adapter-node starts listening.
 */
export const NODE_ENTRY = `import { attach } from './server/svelte-ws-socket.js';
import { server } from './server/adapter-index.js';

attach(server);

export * from './server/adapter-index.js';
`;
