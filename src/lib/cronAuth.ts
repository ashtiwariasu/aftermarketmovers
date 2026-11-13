import type { NextRequest } from "next/server";

/** Secret Manager values may include a trailing newline; HTTP headers cannot. */
export function cronTokenAuthorized(
  expected: string | undefined,
  supplied: string | null,
): boolean {
  const normalizedExpected = expected?.trim() ?? "";
  return normalizedExpected.length > 0 && supplied?.trim() === normalizedExpected;
}

export function requestCronTokenAuthorized(request: NextRequest): boolean {
  return cronTokenAuthorized(
    process.env.CRON_TOKEN,
    request.headers.get("x-cron-token"),
  );
}
