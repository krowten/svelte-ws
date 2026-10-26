// Fixture for vite.spec.ts — parsed by the plugin's transform, never executed.
import { stream, mutate } from '#lib/socket/index.js';
import * as v from 'valibot';

const schema = v.object({ room: v.string() });

export const messages = stream(schema, async function* () {});
export const send = mutate(schema, () => {});
const internal = stream(async function* () {});
void internal;
