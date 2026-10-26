import { json } from '@sveltejs/kit';
import { liveSubscriptions } from '../chat-shared';

/** How many `messages` streams are open for `?room=`, as the server sees it. */
export const GET = ({ url }) =>
	json(liveSubscriptions.get(url.searchParams.get('room') ?? '') ?? 0);
