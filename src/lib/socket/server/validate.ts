import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Issue } from '../protocol.js';
import type { SocketError } from '../error.js';

import { isSocketError } from '../error.js';

/** An `Error` carrying Standard Schema issues. */
export type ValidationError = Error & { name: 'ValidationError'; issues: Issue[] };

/** Create a {@link ValidationError} (branded so it survives across realms). */
export function validationError(issues: Issue[]): ValidationError {
	const error = new Error(issues[0]?.message ?? 'Validation failed') as ValidationError;
	error.name = 'ValidationError';
	error.issues = issues;
	return error;
}

export function isValidationError(value: unknown): value is ValidationError {
	return value instanceof Error && value.name === 'ValidationError' && 'issues' in value;
}

/**
 * Create an error whose message is meant for the user, so it crosses the wire verbatim. Anything
 * else a handler throws is treated as a bug and redacted — see {@link toIssues}.
 *
 * ```ts
 * export const join = mutate(schema, ({ room }) => {
 *   if (isFull(room)) throw socketError('This room is full');
 *   …
 * });
 * ```
 */
export function socketError(message: string, issues?: Issue[]): SocketError {
	const error = new Error(message) as SocketError;
	error.name = 'SocketError';
	error.issues = issues ?? [{ message }];
	return error;
}

/**
 * Validate `input` against a Standard Schema. Returns the parsed value, or throws a
 * {@link ValidationError}. A `null` schema means "no arguments" — input is returned as-is.
 */
export async function validate(schema: StandardSchemaV1 | null, input: unknown): Promise<unknown> {
	if (!schema) return input;

	let result = schema['~standard'].validate(input);
	if (result instanceof Promise) result = await result;

	if (result.issues) {
		throw validationError(
			result.issues.map((issue) => ({
				message: issue.message,
				path: issue.path?.map((seg) => (typeof seg === 'object' ? seg.key : seg))
			}))
		);
	}

	return result.value;
}

/** Message sent instead of an unexpected error, mirroring SvelteKit's own wording. */
export const INTERNAL_ERROR = 'Internal Error';

/**
 * Normalise a thrown value into wire `Issue[]`.
 *
 * Validation failures and {@link socketError}s were written for the user, so they cross as
 * they are. **Everything else is redacted**: a stray `Error` can carry a connection string,
 * a filesystem path or a SQL fragment, and it would otherwise land in the browser. This is
 * the same bargain SvelteKit strikes in `handleError`.
 */
export function toIssues(err: unknown, expose = false): Issue[] {
	if (isValidationError(err) || isSocketError(err)) return err.issues;
	if (expose) {
		return [{ message: err instanceof Error ? err.message : String(err) }];
	}
	return [{ message: INTERNAL_ERROR }];
}
