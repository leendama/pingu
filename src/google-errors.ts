/** Only use around a Google resource lookup, never around model or delivery calls. */
export function isMissingGoogleResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; response?: { status?: unknown } };
  const status = Number(value.response?.status ?? value.code);
  return status === 404 || status === 410;
}
