import type { LayoutServerLoad } from './$types';

import { findByRoute } from '#lib/nav.js';
import { docSource, lastModified } from '#lib/server/lastmod.js';

export const load: LayoutServerLoad = ({ route }) => {
	const slug = findByRoute(route.id).current?.slug;
	return { updated: slug ? lastModified(docSource(slug)) : null };
};
