/**
 * Records implementation details without exposing them in the product UI.
 * Callers must pair this with a curated user-facing message.
 */
export function reportError(context: string, error: unknown) {
  console.error(`[LineCut] ${context}`, error);
}
