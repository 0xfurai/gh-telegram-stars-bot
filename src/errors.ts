/** A thrown value's message, for logs. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
