const DOCUMENT_ID = /^[0-9a-fA-F-]{10,40}$/;

/**
 * Context exclusions may identify a filed document or a canonical fresh-source
 * URL. Fresh sources are not persisted as documents until the member chooses
 * "File it", so their URL is their stable selection key.
 */
export function isContextSourceKey(value: string): boolean {
  if (DOCUMENT_ID.test(value)) return true;
  if (value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeContextExclusions(values: unknown[]): string[] {
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(isContextSourceKey)
  )].slice(0, 200);
}
