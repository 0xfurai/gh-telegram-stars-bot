// Rust-style results for expected failures.
//
// * Result<T, E>: an operation that can fail in a way the caller must handle
//   (invalid settings, "not subscribed", a repository GitHub doesn't know).
//   Check `.ok` before using `.value` or `.error`; TypeScript narrows it.
// * Exceptions: bugs and infrastructure failures (a D1 error, a broken
//   invariant). Like Rust's panic, they aren't part of the return type.
// * `T | null`: something that may simply be absent, like Rust's Option.
//
// Error types are string-literal unions or tagged objects ({ kind: ... }), so
// callers can `switch` over them. ESLint's switch-exhaustiveness-check fails
// a switch that misses a case; assertNever does the same at runtime.

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** For the default branch of an exhaustive switch: fails to compile if a case is missing. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
