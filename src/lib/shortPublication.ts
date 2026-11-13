export type ShortPublicationRecord = Record<string, unknown> | undefined;

export function shortPublicationIsHandled(
  record: ShortPublicationRecord,
  now = Date.now(),
): boolean {
  const status = String(record?.status ?? "");
  if (status === "scheduled" || status === "published") return true;
  return status === "processing" && Number(record?.leaseExpiresAt ?? 0) > now;
}
