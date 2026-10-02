/** Human-readable message from a thrown value (Error, tRPC error shape), or null when it has none. */
export function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}
