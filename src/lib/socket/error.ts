import type { Issue } from './types.js';

/**
 * An error whose issues are meant for the user: thrown on the server with `socketError()`,
 * and what a failed operation rejects with on the client.
 */
export type SocketError = Error & { name: 'SocketError'; issues: Issue[] };

/** Rebuild a {@link SocketError} from the issues that came over the wire. */
export function fromIssues(issues: Issue[]): SocketError {
	const error = new Error(issues[0]?.message ?? 'Event operation failed') as SocketError;
	error.name = 'SocketError';
	error.issues = issues;
	return error;
}

export function isSocketError(value: unknown): value is SocketError {
	return value instanceof Error && value.name === 'SocketError' && 'issues' in value;
}
